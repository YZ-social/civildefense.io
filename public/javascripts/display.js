const { FileReader, File } = globalThis;
import { resetInactivityTimer } from './main.js';

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
  
export async function file2dataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(showMessage(reader.error.message || reader.error.name || "Error reading attachment"));
    reader.onload = () => {
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
export async function dataURL2file(url, name) {
  const res = await fetch(url);
  const blob = await res.blob();
  return new File([blob], name, {type: blob.type});
}
