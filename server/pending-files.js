/** One ledger for staged files and multipart streams that are still arriving.
 * Keep the Map interface so existing consumers release quota when they delete.
 * Replace entries via set() rather than mutating their buffer or owner.
 */
export class PendingFileStore extends Map {
  #bytesByUser = new Map();
  #totalBytes = 0;

  #adjust(userId, bytes) {
    this.#totalBytes += bytes;
    const userBytes = (this.#bytesByUser.get(userId) ?? 0) + bytes;
    if (userBytes) this.#bytesByUser.set(userId, userBytes);
    else this.#bytesByUser.delete(userId);
  }

  available(userId, perUserBytes, globalBytes) {
    return Math.min(perUserBytes - (this.#bytesByUser.get(userId) ?? 0), globalBytes - this.#totalBytes);
  }

  reserve(userId, bytes, perUserBytes, globalBytes) {
    if (bytes > this.available(userId, perUserBytes, globalBytes)) return false;
    this.#adjust(userId, bytes);
    return true;
  }

  release(userId, bytes) {
    this.#adjust(userId, -bytes);
  }

  set(id, entry) {
    this.delete(id);
    this.#adjust(entry.userId, entry.buffer.length);
    return super.set(id, entry);
  }

  delete(id) {
    const entry = this.get(id);
    if (!super.delete(id)) return false;
    this.release(entry.userId, entry.buffer.length);
    return true;
  }

  clear() {
    // Do not clear reservations for requests currently being read.
    for (const id of this.keys()) this.delete(id);
  }

  prune(now, ttlMs) {
    for (const [id, entry] of this) {
      if (now - entry.uploadedAt >= ttlMs) this.delete(id);
    }
  }
}
