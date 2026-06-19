#!/bin/bash
#
# Remove o serviço automático do painel Uranus2 (launchd).
# Uso:  bash scripts/uninstall-service.sh
#
set -e

LABEL="com.uranus2.whatsapp"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"

echo "✅ Serviço removido. O painel não inicia mais automaticamente."
echo "   Para rodar manualmente: npm start"
