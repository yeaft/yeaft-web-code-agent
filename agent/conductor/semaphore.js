/**
 * Conductor — 全局并发信号量
 *
 * 控制 Claude 实例并发上限。所有需要启动 Claude 进程的地方
 * 都必须先 acquire，用完 release。
 *
 * 使用方式：
 *   const release = await semaphore.acquire();
 *   try { ... } finally { release(); }
 */

export class Semaphore {
  /**
   * @param {number} max - 最大并发数
   */
  constructor(max = 5) {
    this._max = max;
    this._current = 0;
    this._queue = [];
  }

  get current() { return this._current; }
  get max() { return this._max; }
  get waiting() { return this._queue.length; }

  /**
   * 获取一个许可。如果已满则等待。
   * @returns {Promise<() => void>} release 函数
   */
  acquire() {
    if (this._current < this._max) {
      this._current++;
      return Promise.resolve(this._createRelease());
    }

    return new Promise(resolve => {
      this._queue.push(() => {
        this._current++;
        resolve(this._createRelease());
      });
    });
  }

  /**
   * 尝试非阻塞获取。返回 release 函数或 null。
   * @returns {(() => void) | null}
   */
  tryAcquire() {
    if (this._current < this._max) {
      this._current++;
      return this._createRelease();
    }
    return null;
  }

  _createRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._current--;
      if (this._queue.length > 0) {
        const next = this._queue.shift();
        next();
      }
    };
  }
}

/** 全局单例 */
export const globalSemaphore = new Semaphore(
  parseInt(process.env.CONDUCTOR_MAX_CLAUDES || '5', 10)
);
