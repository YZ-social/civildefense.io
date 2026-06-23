const { pica, FileReader, File, URL } = globalThis;
import { resetInactivityTimer } from './main.js';
import { showMessage } from './map.js';

export function consume(event) { // i.e., don't close dialogs
  event?.stopPropagation();
  resetInactivityTimer();
}

export function openDisplay(containerIdentifier, event = null, content = undefined) {
  // Open containerIdentifier with close handler attached and optional content, and return content element
  const containerElement = document.getElementById(containerIdentifier);
  consume(event);

  containerElement.onclick = event => {
    resetInactivityTimer();
    containerElement.classList.toggle('hidden', true);
  };

  const contentElement = containerElement.firstElementChild;
  if (content !== undefined) contentElement.innerHTML = content;

  containerElement.classList.toggle('hidden', false);  
  return contentElement;
}
