import asyncio
import functools
import time


def async_retry(timeout=300, interval=1):
    def decorator(function):
        @functools.wraps(function)
        async def wrapped(*args, **kwargs):
            deadline = time.monotonic() + timeout
            last_error = None
            while time.monotonic() < deadline:
                try:
                    return await function(*args, **kwargs)
                except Exception as error:
                    last_error = error
                    await asyncio.sleep(interval)
            if last_error:
                raise last_error
            raise TimeoutError(f"{function.__name__} timed out")

        return wrapped

    return decorator
