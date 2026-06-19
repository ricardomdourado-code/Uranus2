#!/bin/bash
#
# Instala o painel Uranus2 como um serviço do macOS (launchd).
# Assim o servidor inicia sozinho quando o Mac liga e reinicia caso caia —
# garantindo que o WhatsApp esteja sempre escutando e nenhuma mensagem se perca.
#
# Uso:  bash scripts/install-service.sh
#
set -e

LABEL="com.uranus2.whatsapp"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Diretório do projeto = pasta acima deste script.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Caminho do Node (resolve mesmo via nvm/homebrew).
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "❌ Node não encontrado no PATH. Instale o Node ou rode 'which node' para conferir."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$REPO_DIR/logs"

echo "📦 Projeto:   $REPO_DIR"
echo "🟢 Node:      $NODE_BIN"
echo "📄 Serviço:   $PLIST"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$REPO_DIR/src/index.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>

    <!-- Inicia ao logar e mantém vivo (reinicia se cair). -->
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>

    <!-- Espera 5s antes de reiniciar, para não entrar em loop agressivo. -->
    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>StandardOutPath</key>
    <string>$REPO_DIR/logs/uranus2.out.log</string>
    <key>StandardErrorPath</key>
    <string>$REPO_DIR/logs/uranus2.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
PLISTEOF

# Recarrega o serviço (descarrega se já existir).
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo ""
echo "✅ Serviço instalado e iniciado!"
echo "   • Logs:    $REPO_DIR/logs/uranus2.out.log  (e .err.log)"
echo "   • Painel:  http://localhost:3000"
echo ""
echo "Comandos úteis:"
echo "   Parar:      launchctl unload $PLIST"
echo "   Iniciar:    launchctl load $PLIST"
echo "   Status:     launchctl list | grep $LABEL"
echo "   Remover:    bash scripts/uninstall-service.sh"
