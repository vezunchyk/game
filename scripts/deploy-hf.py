"""
Заливає проєкт на Hugging Face Space одним запуском.

Використання:
    pip install huggingface_hub
    export HF_TOKEN=hf_...                 # токен з правом Write (Settings -> Access Tokens)
    export SUPABASE_URL=https://xxx.supabase.co        # необов'язково
    export SUPABASE_SERVICE_KEY=eyJ...                 # необов'язково
    python scripts/deploy-hf.py ТВІЙ_НІК/назва-простору

Space створиться сам (тип Docker), якщо його ще немає.
Повторний запуск просто оновлює файли.
"""
import os
import sys
from getpass import getpass
from pathlib import Path

from huggingface_hub import HfApi

if len(sys.argv) != 2 or "/" not in sys.argv[1]:
    sys.exit("Вкажи Space у форматі нік/назва, наприклад: python scripts/deploy-hf.py ivan/zona")

repo_id = sys.argv[1]
token = os.environ.get("HF_TOKEN") or getpass("HF токен (Write): ")
root = Path(__file__).resolve().parent.parent

api = HfApi(token=token)

# 1. Створюємо Space (Docker), якщо його немає
api.create_repo(repo_id=repo_id, repo_type="space", space_sdk="docker", exist_ok=True)

# 2. Секрети Supabase (якщо задані в середовищі) — зберігаються на Hugging Face, не у файлах
for key in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
    value = os.environ.get(key)
    if value:
        api.add_space_secret(repo_id=repo_id, key=key, value=value)
        print(f"Секрет {key} встановлено")

# 3. Заливаємо файли (без зайвого: залежності і збірка робляться в Docker)
api.upload_folder(
    repo_id=repo_id,
    repo_type="space",
    folder_path=str(root),
    ignore_patterns=["node_modules/*", "dist/*", ".git/*", "public/game.js", "__pycache__/*", "*.zip"],
    commit_message="Деплой з deploy-hf.py",
)

print(f"Готово: https://huggingface.co/spaces/{repo_id}")
print("Збірка Docker іде кілька хвилин; стан видно на сторінці Space.")
