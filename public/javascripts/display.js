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
  
export async function file2dataURL(file) { // Promise a dataURL string from file (which may be File or Blob).
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(showMessage(reader.error.message || reader.error.name || "Error reading attachment"));
    reader.onload = () => {
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
export async function dataURL2file(url, name) { // Promise a File object corresponding to the given dataURL and file name string.
  const res = await fetch(url);
  const blob = await res.blob();
  return new File([blob], name, {type: blob.type});
}

function getCanvas(file) { // Promise a Canvas from a File of type image/*.
  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(img.src);
      resolve(canvas);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
};

export async function downsampledFile2dataURL(file, maxDimension = 1024) { // Promise a reasonably sized dataURL for a given File of type image/*
  if (!file.type.startsWith('image/')) return await file2dataURL(file);

  let sizedWidth, sizedHeight;  // Largest will be 1024, preserving aspect ratio.
  const from = await getCanvas(file);
  const {width, height} = from;
  if (width > height) {
    sizedWidth = maxDimension;
    sizedHeight = Math.round(maxDimension * height/width);
  } else {
    sizedHeight = maxDimension;
    sizedWidth = Math.round(maxDimension * width/height);
  }
  if (sizedWidth >= width) return await file2dataURL(file);

  const resizer = pica();
  const to = document.createElement('canvas');
  to.width = sizedWidth;
  to.height = sizedHeight;
  const result = await resizer.resize(from, to);
  const blob = await resizer.toBlob(result, file.type, 0.90);
  const dataURL = await file2dataURL(blob);
  console.warn('downsized', file.name, `${width}x${height}`, file.size.toLocaleString(),
	       'to blob:', `${sizedWidth}x${sizedHeight}`, blob.size.toLocaleString(),
	       'dataURL:', dataURL.length.toLocaleString());
  return dataURL;
}
