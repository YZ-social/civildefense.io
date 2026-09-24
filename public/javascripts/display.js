const { pica, FileReader, File, URL, localStorage } = globalThis;
import { closeAll, resetInactivityTimer } from './main.js';

export function consume(event) { // i.e., don't close dialogs
  event?.stopPropagation();
  resetInactivityTimer();
}

export function openDisplay(containerIdentifier, event = null, content = undefined) {
  // Open containerIdentifier with close handler attached and optional content, and return content element
  const containerElement = document.getElementById(containerIdentifier);
  consume(event);
  closeAll();

  containerElement.onclick = event => {
    resetInactivityTimer();
    containerElement.classList.toggle('hidden', true);
  };

  const contentElement = containerElement.firstElementChild;
  if (content !== undefined) contentElement.innerHTML = content;

  containerElement.classList.toggle('hidden', false);  
  return contentElement;
}

const infoBanner = document.getElementById('info');
let messageTimeout;
export function showMessage(message, type = 'loading', errorObject) { // Show loading/instructions/error message.
  if (errorObject || type === 'error' ) console.error(message, errorObject || '');
  else if (message) console.warn(message);
  if (!message) {
    infoBanner.style.display = 'none';
    return;
  }

  if (infoBanner.style) infoBanner.style = '';
  infoBanner.innerHTML = message;
  const className = `info-banner ${type}`;
  if (infoBanner.className !== className) infoBanner.className = className;

  if (type === 'instructions') {
    clearTimeout(messageTimeout);
    messageTimeout = setTimeout(() => infoBanner.style.display = 'none', 5e3);
  }
}

export function teach(classname) {
  if (localStorage.getItem(classname)) return;
  localStorage.setItem(classname, '1');
  document.body.classList.toggle(classname, true);
  document.querySelectorAll('.teach').forEach(element => element.onclick = closeTeach);
}
export function closeTeach() { // All of them.
  document.body.classList.toggle('firstConversation', false);
  document.body.classList.toggle('firstPublish', false);
  document.body.classList.toggle('firstTopics', false);
}
