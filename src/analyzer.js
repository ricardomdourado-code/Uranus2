import OpenAI from 'openai';
import { config } from './config.js';
import { logger } from './logger.js';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

const PRIORITY_LEVELS = ['CRITICA', 'ALTA', 'MEDIA', 'BAIXA'];

/**
 * Build the analysis prompt for a batch of chats.
 */
function buildAnalysisPrompt(chatsData) {
  const now = format(toZonedTime(new Date(), config.timezone), "dd/MM/yyyy HH:mm:ss");

  const chatsJson = JSON.stringify(chatsData, null, 2);

  return `Você é um assistente executivo especializado em priorização de comunicações corporativas para ${config.whatsapp.ownerName}.

Data/Hora atual: ${now} (Fuso horário: ${config.timezone})

Analise as seguintes conversas do WhatsApp e retorne um JSON estruturado com a análise de cada uma.

## CRITÉRIOS DE PRIORIDADE:

**CRITICA** — Requer ação imediata (próximas 1-2 horas):
- Financeiro urgente: pagamentos, cobranças, inadimplência, fluxo de caixa
- RH/Decisões executivas: demissões, contratações urgentes, crises
- Clientes ou parceiros estratégicos com problemas graves
- Situações de risco operacional ou reputacional

**ALTA** — Requer ação hoje:
- Operações de produção com pendências ou atrasos
- Aprovações necessárias que bloqueiam equipes
- Pendências de equipe que impactam entregas
- Fornecedores com problemas críticos

**MEDIA** — Requer ação em 24-48 horas:
- Atualizações operacionais e relatórios de rotina
- Coordenação de equipe sem urgência crítica
- Reuniões e agendamentos pendentes
- Informações que precisam de resposta mas não são urgentes

**BAIXA** — Pode aguardar:
- Conversas pessoais e sociais
- Informativo sem necessidade de resposta
- Grupos de entretenimento, notícias gerais
- Mensagens que já foram respondidas ou não requerem ação

## DADOS DAS CONVERSAS:
${chatsJson}

## INSTRUÇÕES DE RESPOSTA:

Retorne APENAS um JSON válido (sem markdown, sem texto adicional) com o seguinte formato:
{
  "analyses": [
    {
      "jid": "id_da_conversa",
      "name": "Nome da Conversa",
      "priority": "CRITICA|ALTA|MEDIA|BAIXA",
      "priorityReason": "Motivo da prioridade em 1 frase",
      "summary": "Resumo de 2-3 linhas do conteúdo recente das mensagens",
      "suggestedResponse": "Sugestão de resposta em português (null se não precisar responder)",
      "actionItems": ["ação 1", "ação 2"],
      "requiresResponse": true,
      "urgencyScore": 1-10
    }
  ]
}

Analise cada conversa individualmente. Se não houver mensagens suficientes, classifique como BAIXA.
Retorne análise para TODAS as conversas fornecidas, na mesma ordem.`;
}

/**
 * Parse GPT response safely, extracting JSON.
 */
function parseGPTResponse(content) {
  try {
    // Try direct parse
    return JSON.parse(content);
  } catch {
    // Try to extract JSON from markdown code block
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        // fall through
      }
    }
    // Try to find raw JSON object
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // fall through
      }
    }
    throw new Error('Não foi possível extrair JSON da resposta GPT');
  }
}

/**
 * Prepare chat data for analysis (trim messages, format timestamps).
 */
function prepareChatData(chat) {
  const messages = (chat.messages || [])
    .slice(-config.analysis.maxMessagesPerChat)
    .map((m) => ({
      from: m.fromMe ? config.whatsapp.ownerName : m.senderName,
      text: m.text || `[${m.type}]`,
      time: m.timestamp
        ? format(toZonedTime(m.timestamp, config.timezone), 'HH:mm dd/MM')
        : 'N/A',
    }))
    .filter((m) => m.text && m.text !== '[unknown]');

  return {
    jid: chat.jid,
    name: chat.name,
    type: chat.type,
    unreadCount: chat.unreadCount,
    participantCount: chat.participants?.length || 0,
    lastMessageTime: chat.lastMessageTime
      ? format(toZonedTime(chat.lastMessageTime, config.timezone), 'HH:mm dd/MM/yyyy')
      : null,
    recentMessages: messages,
  };
}

/**
 * Classify and summarize a batch of chats via GPT.
 * @param {Array} batch - Array of prepared chat data objects
 * @returns {Promise<Array>}
 */
async function analyzeBatch(batch) {
  const prompt = buildAnalysisPrompt(batch);

  logger.info(`Enviando lote de ${batch.length} conversas para GPT...`);

  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 4000,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content || '{}';
  const parsed = parseGPTResponse(content);

  return parsed.analyses || [];
}

/**
 * Main function: classify and summarize all chats with messages.
 * Batches into groups of config.analysis.batchSize.
 * @param {Array} chatsWithMessages - Array of chat objects with .messages property
 * @returns {Promise<Array>}
 */
export async function classifyAndSummarizeChats(chatsWithMessages) {
  if (!config.openai.apiKey) {
    logger.warn('OPENAI_API_KEY não configurada. Retornando análise padrão.');
    return chatsWithMessages.map((chat) => ({
      jid: chat.jid,
      name: chat.name,
      priority: 'MEDIA',
      priorityReason: 'Análise GPT não disponível (API key ausente)',
      summary: `Conversa com ${chat.unreadCount} mensagem(ns) não lida(s).`,
      suggestedResponse: null,
      actionItems: [],
      requiresResponse: false,
      urgencyScore: 5,
      unreadCount: chat.unreadCount,
      lastMessageTime: chat.lastMessageTime,
      type: chat.type,
    }));
  }

  const preparedChats = chatsWithMessages.map(prepareChatData);
  const batchSize = config.analysis.batchSize;
  const batches = [];

  for (let i = 0; i < preparedChats.length; i += batchSize) {
    batches.push(preparedChats.slice(i, i + batchSize));
  }

  logger.info(`Analisando ${chatsWithMessages.length} conversas em ${batches.length} lote(s) de até ${batchSize}`);

  const allAnalyses = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    logger.info(`Processando lote ${i + 1}/${batches.length}...`);

    try {
      const results = await analyzeBatch(batch);

      // Merge GPT results with original chat data
      for (const result of results) {
        const original = chatsWithMessages.find((c) => c.jid === result.jid);
        allAnalyses.push({
          jid: result.jid,
          name: result.name || original?.name || result.jid,
          priority: PRIORITY_LEVELS.includes(result.priority) ? result.priority : 'MEDIA',
          priorityReason: result.priorityReason || '',
          summary: result.summary || '',
          suggestedResponse: result.suggestedResponse || null,
          actionItems: Array.isArray(result.actionItems) ? result.actionItems : [],
          requiresResponse: result.requiresResponse || false,
          urgencyScore: result.urgencyScore || 5,
          unreadCount: original?.unreadCount || 0,
          lastMessageTime: original?.lastMessageTime || null,
          lastMessage: original?.lastMessage || null,
          type: original?.type || 'Contato',
          participants: original?.participants || [],
          mentionedOwner: original?.mentionedOwner || false,
        });
      }

      // Add any chats from the batch that GPT didn't return
      for (const chat of batch) {
        if (!allAnalyses.find((a) => a.jid === chat.jid)) {
          const original = chatsWithMessages.find((c) => c.jid === chat.jid);
          allAnalyses.push({
            jid: chat.jid,
            name: chat.name,
            priority: 'BAIXA',
            priorityReason: 'Sem dados suficientes para análise',
            summary: 'Sem mensagens recentes ou conteúdo insuficiente.',
            suggestedResponse: null,
            actionItems: [],
            requiresResponse: false,
            urgencyScore: 1,
            unreadCount: original?.unreadCount || 0,
            lastMessageTime: original?.lastMessageTime || null,
            lastMessage: original?.lastMessage || null,
            type: original?.type || 'Contato',
            participants: original?.participants || [],
            mentionedOwner: original?.mentionedOwner || false,
          });
        }
      }

      // Small delay between batches to avoid rate limiting
      if (i < batches.length - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      logger.error({ err }, `Erro ao analisar lote ${i + 1}`);

      // Add fallback entries for failed batch
      for (const chat of batch) {
        allAnalyses.push({
          jid: chat.jid,
          name: chat.name,
          priority: 'MEDIA',
          priorityReason: 'Erro na análise GPT',
          summary: `Não foi possível analisar esta conversa (erro: ${err.message}).`,
          suggestedResponse: null,
          actionItems: [],
          requiresResponse: false,
          urgencyScore: 5,
          unreadCount: chatsWithMessages.find((c) => c.jid === chat.jid)?.unreadCount || 0,
          lastMessageTime: chatsWithMessages.find((c) => c.jid === chat.jid)?.lastMessageTime || null,
          type: chatsWithMessages.find((c) => c.jid === chat.jid)?.type || 'Contato',
        });
      }
    }
  }

  // Sort by priority then urgencyScore
  const priorityOrder = { CRITICA: 0, ALTA: 1, MEDIA: 2, BAIXA: 3 };
  allAnalyses.sort((a, b) => {
    const po = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (po !== 0) return po;
    return (b.urgencyScore || 0) - (a.urgencyScore || 0);
  });

  logger.info(`Análise concluída: ${allAnalyses.length} conversas classificadas`);
  return allAnalyses;
}

/**
 * Generate a high-level executive summary from analyzed chats.
 * @param {Array} analyzedChats
 * @returns {Promise<string>}
 */
export async function generateExecutiveSummary(analyzedChats) {
  const counts = { CRITICA: 0, ALTA: 0, MEDIA: 0, BAIXA: 0 };
  const unread = { CRITICA: 0, ALTA: 0, MEDIA: 0, BAIXA: 0 };

  for (const chat of analyzedChats) {
    counts[chat.priority] = (counts[chat.priority] || 0) + 1;
    unread[chat.priority] = (unread[chat.priority] || 0) + (chat.unreadCount || 0);
  }

  const criticalChats = analyzedChats
    .filter((c) => c.priority === 'CRITICA')
    .slice(0, 5)
    .map((c) => `- ${c.name}: ${c.summary}`)
    .join('\n');

  if (!config.openai.apiKey) {
    return buildFallbackExecutiveSummary(analyzedChats, counts, unread);
  }

  try {
    const prompt = `Você é um assistente executivo de ${config.whatsapp.ownerName}.

Com base na análise das conversas do WhatsApp, gere um resumo executivo conciso em português.

ESTATÍSTICAS:
- Críticas: ${counts.CRITICA} conversas (${unread.CRITICA} msgs não lidas)
- Altas: ${counts.ALTA} conversas (${unread.ALTA} msgs não lidas)
- Médias: ${counts.MEDIA} conversas (${unread.MEDIA} msgs não lidas)
- Baixas: ${counts.BAIXA} conversas (${unread.BAIXA} msgs não lidas)

CONVERSAS CRÍTICAS:
${criticalChats || 'Nenhuma conversa crítica identificada.'}

Gere:
1. Um parágrafo de situação geral (2-3 frases)
2. Lista de 3-5 ações imediatas recomendadas (numeradas)

Seja direto e objetivo. Responda em texto puro, sem markdown.`;

    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 600,
    });

    return response.choices[0]?.message?.content || buildFallbackExecutiveSummary(analyzedChats, counts, unread);
  } catch (err) {
    logger.warn({ err }, 'Erro ao gerar resumo executivo, usando fallback');
    return buildFallbackExecutiveSummary(analyzedChats, counts, unread);
  }
}

function buildFallbackExecutiveSummary(analyzedChats, counts, unread) {
  const lines = [];
  const totalUnread = Object.values(unread).reduce((a, b) => a + b, 0);

  lines.push(`Total de ${analyzedChats.length} conversas analisadas com ${totalUnread} mensagens não lidas.`);

  if (counts.CRITICA > 0) {
    lines.push(`ATENÇÃO: ${counts.CRITICA} conversa(s) crítica(s) requerem resposta imediata.`);
  }
  if (counts.ALTA > 0) {
    lines.push(`${counts.ALTA} conversa(s) de alta prioridade necessitam atenção hoje.`);
  }

  lines.push('');
  lines.push('AÇÕES IMEDIATAS RECOMENDADAS:');

  const criticalChats = analyzedChats.filter((c) => c.priority === 'CRITICA');
  criticalChats.slice(0, 3).forEach((c, i) => {
    lines.push(`${i + 1}. Responder "${c.name}" - ${c.priorityReason}`);
  });

  if (criticalChats.length === 0) {
    const highChats = analyzedChats.filter((c) => c.priority === 'ALTA');
    highChats.slice(0, 3).forEach((c, i) => {
      lines.push(`${i + 1}. Verificar "${c.name}" - ${c.priorityReason}`);
    });
  }

  return lines.join('\n');
}
