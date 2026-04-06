import { resetInactivityTimer } from './main.js';

export function openDisplay(containerIdentifier, event = null, content = undefined) {
  // Open containerIdentifier with close handler attached and optional content, and return content element
  const containerElement = document.getElementById(containerIdentifier);
  console.log('openDisplay', {event, containerIdentifier, containerElement});
  event?.stopPropagation();
  resetInactivityTimer();

  containerElement.onclick = event => {
    resetInactivityTimer();
    containerElement.classList.toggle('hidden', true);
  };

  const contentElement = containerElement.firstElementChild;
  if (content !== undefined) contentElement.innerHTML = content;

  containerElement.classList.toggle('hidden', false);  
  return contentElement;
}
  
