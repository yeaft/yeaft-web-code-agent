export const selectors = {
  // Login
  loginUsername: '[data-testid="login-username"]',
  loginPassword: '[data-testid="login-password"]',
  loginButton:   '[data-testid="login-submit"]',

  // Chat
  chatInput:     '[data-testid="chat-input"]',
  sendButton:    '[data-testid="send-button"]',
  messageList:   '.message-list',
  messageItem:   '.message-item',

  // Sidebar
  sidebar:       '.sidebar',
  newConvButton: '[data-testid="new-conversation"]',
  convList:      '.conversation-list',

  // Workbench
  workbenchLauncher: '.workbench-launcher',
  terminalCapability: '[data-workbench-capability="terminal"]',
  fileCapability: '[data-workbench-capability="files"]',
  gitCapability: '[data-workbench-capability="git"]',
  browserCapability: '[data-workbench-capability="browser"]',

  // Proxy
  proxyPortInput: '.proxy-input-port',
  proxyAddBtn:    '.proxy-add-btn',
  proxyToggle:    '.proxy-toggle',


};
