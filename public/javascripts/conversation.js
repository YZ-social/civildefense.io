// TODO:
// - replies
// - In Alert, get rid of subject (just use tag)
// - key off 'deleted' instead of payload:null, and bring handling here
// - Extendable Reply class
// - Bring pub/sub here, customizable for SpatialConversation subclass

export class Conversation { // Maintains name, agent, replies around a given tag.

  // CONVERSATION API
  static ensure({tag, ...rest}) { // update() or initialize() conversation and remember what those answer. (Falsy is deleted).
    let conversation = this.getConversation(tag);

    if (conversation) conversation = conversation.update(rest);
    else conversation = new this().initialize({tag, ...rest});

    if (!conversation) return this.removeConversation(tag);
    return this.conversations[tag] = conversation;
  }
  initialize({...properties} = {}) { // Initialization of a new object. (Includes tag.) Must return this, or null to not cache.
    // Application subclass will typically extend this with UI initialization
    Object.assign(this, properties);
    return this;
  }
  update({...properties} = {}) { // Re-initialize an existing object with properties. Must return this, or null to removeConversation.
    // This version gives error when specified values (if any) do not match existing.
    // Since axona publications are immutable, an update with different values would generally be meaningless.
    for (const key in properties) {
      const existing = this[key];
      const proposed = properties[key];
      if (existing != proposed) throw new Error(`Cannot update ${key} ${existing} to ${proposed}.`);
    }
    return this;
  }
  destroy() { // Uncaches and returns falsy.
    // Application subclass will typically extend this with UI effects.
    this.constructor.removeConversation(this.tag);
  }
  static eachConversation(callback) { // Apply callback to each cached conversation.
    Object.values(this.conversation).forEach(callback);
  }

  // Core machinery.
  // Multiton pattern, with each subclass getting its own dictionary.
  static _conversations = {}; // Maps tag => conversation
  static get conversations() { // Answer conversation dictionary for this specific class.
    if (!Object.hasOwn(this, '_conversations')) this._conversations = {};
    return this._conversations;
  }
  static removeConversation(tag) { // Remove conversation from cache.
    delete this._conversations[tag];
  }
  static getConversation(tag) { // Get conversation if known, else falsy.
    return this.conversations[tag];
  }
}
