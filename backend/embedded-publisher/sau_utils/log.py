import logging
import sys


class _PublisherLogger:
    def __init__(self, name):
        self._logger = logging.getLogger(f"embedded-publisher.{name}")
        if not self._logger.handlers:
            handler = logging.StreamHandler(sys.stderr)
            handler.setFormatter(logging.Formatter("[%(name)s] %(levelname)s %(message)s"))
            self._logger.addHandler(handler)
            self._logger.setLevel(logging.DEBUG)
            self._logger.propagate = False

    def debug(self, message):
        self._logger.debug(message)

    def info(self, message):
        self._logger.info(message)

    def warning(self, message):
        self._logger.warning(message)

    def error(self, message):
        self._logger.error(message)

    def success(self, message):
        self._logger.info(message)


douyin_logger = _PublisherLogger("douyin")
tencent_logger = _PublisherLogger("tencent")
xiaohongshu_logger = _PublisherLogger("xiaohongshu")
kuaishou_logger = _PublisherLogger("kuaishou")
bilibili_logger = _PublisherLogger("bilibili")
baijiahao_logger = _PublisherLogger("baijiahao")
