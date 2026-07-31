#!/data/data/com.termux/files/usr/bin/bash
#
# Установка на телефон (Android / Termux).
# Запускается ОДИН раз. После этого на рабочем столе появится значок,
# по которому программа открывается одним нажатием.
#
#   bash установить-на-телефон.sh
#

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "============================================================"
echo "  Установка на телефон"
echo "============================================================"
echo

# --- 1. Python ---
if ! command -v python >/dev/null 2>&1; then
    echo "[1/4] Ставлю Python..."
    pkg install -y python >/dev/null 2>&1
else
    echo "[1/4] Python уже есть."
fi

# --- 2. Node.js (нужен для входа по подписке) ---
if ! command -v npm >/dev/null 2>&1; then
    echo "[2/4] Ставлю Node.js (нужен для работы по подписке)..."
    pkg install -y nodejs >/dev/null 2>&1
else
    echo "[2/4] Node.js уже есть."
fi

# --- 3. Ярлык на рабочий стол ---
echo "[3/4] Создаю ярлык для рабочего стола..."
SHORTCUTS="$HOME/.shortcuts"
mkdir -p "$SHORTCUTS"

cat > "$SHORTCUTS/Навигатор" << EOF
#!/data/data/com.termux/files/usr/bin/bash
cd "$HERE"
python start.py
echo
echo "--- Готово. Нажми Enter чтобы закрыть ---"
read
EOF

chmod +x "$SHORTCUTS/Навигатор"

# --- 4. Проверка ---
echo "[4/4] Проверяю..."
cd "$HERE"
if python -c "import sys; sys.path.insert(0,'docker'); import model_providers, knowledge, cli_providers" 2>/dev/null; then
    echo "      Программа на месте, всё читается."
else
    echo "      [!] Что-то не так с файлами программы."
    exit 1
fi

echo
echo "============================================================"
echo "  Установка закончена"
echo "============================================================"
echo
echo "ОСТАЛОСЬ ДВА ДЕЙСТВИЯ — сделай их руками на телефоне:"
echo
echo "  1. Установи приложение Termux:Widget"
echo "     (там же, где ставил Termux — в F-Droid)"
echo
echo "  2. На рабочем столе телефона задержи палец на пустом месте,"
echo "     выбери «Виджеты», найди Termux:Widget и перетащи на экран."
echo "     В появившемся списке выбери «Навигатор»."
echo
echo "После этого программа открывается ОДНИМ нажатием по значку."
echo
echo "Вход в аккаунт (делается один раз, нужен браузер):"
echo "  npm install -g @anthropic-ai/claude-code  &&  claude"
echo "или"
echo "  npm install -g @google/gemini-cli  &&  gemini"
echo
