from pathlib import Path

from conf import BASE_DIR


def get_absolute_path(value, platform_dir=""):
    path = Path(value).expanduser()
    if path.is_absolute():
        return str(path)
    if len(path.parts) == 1 and platform_dir:
        return str((Path(BASE_DIR) / "cookies" / platform_dir / path).resolve())
    return str(path.resolve())
