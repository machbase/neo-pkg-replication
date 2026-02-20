const File = require('./file.js');

class Checkpoint {
  constructor(filePath) {
    this.file = new File(filePath);
    this.stores = [];
  }

  async load() {
    if (await this.file.exists()) {
      const data = await this.file.read();
      this.stores = Array.isArray(data) ? data : [];
    } else {
      this.stores = [];
    }
    return this;
  }

  async save() {
    await this.file.write(this.stores);
  }

  getStores() {
    return this.stores;
  }

  get(name) {
    return this.stores.find(store => store.name === name);
  }

  updateRid(name, rid) {
    const store = this.get(name);
    if (store) {
      store.rid = rid;
    }
  }

  initFrom(entries) {
    this.stores = entries.map(entry => ({
      name: entry.name,
      rid: 0n
    }));
  }
}

module.exports = Checkpoint;
