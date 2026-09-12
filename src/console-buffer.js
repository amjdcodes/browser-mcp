import { truncateConsole, CONFIG } from './utils.js';

export class ConsoleBuffer {
  constructor(maxMessages = CONFIG.MAX_CONSOLE_MESSAGES || 500) {
    this.buffer = [];
    this.maxMessages = maxMessages;
  }

  add(message) {
    this.buffer.push(message);
    
    if (this.buffer.length > this.maxMessages) {
      this.buffer.shift();
    }
  }

  clear() {
    this.buffer = [];
  }

  getMessages(level = 'all') {
    if (level === 'all') {
      return [...this.buffer];
    }
    
    return this.buffer.filter(msg => msg.level === level);
  }

  getFormattedMessages(level = 'all', clearAfter = false) {
    const messages = this.getMessages(level);
    const truncated = truncateConsole(messages, CONFIG.MAX_CONSOLE_LINES);
    
    if (clearAfter) {
      this.clear();
    }
    
    return {
      messages: truncated.lines,
      count: messages.length,
      cleared: clearAfter,
      truncated: truncated.truncated,
      droppedCount: truncated.droppedCount || 0
    };
  }
}

export default ConsoleBuffer;
