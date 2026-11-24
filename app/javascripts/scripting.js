// A module with utilities for scripting.

const { SpeechSynthesisUtterance, speechSynthesis} = window;
import { v4 as uuidv4 } from 'uuid';
import { Node } from '@yz-social/kdht';
import { getContainingCells } from './s2.js';
import { delay, positionWatch, networkPromise, disableNotifications } from './main.js';
import { Marker, map, updateLocation, updateSubscriptions, makeEventName, showMessage } from './map.js';
import { Hashtags } from './hashtags.js';
import { Agent } from './agent.js';

function toggle(canonicalTag, kill = false) { // Toggle subscription of specified hashtag (without emoji). Return a promise that resolves after a beat.
  const label = Hashtags.canonical2extended[canonicalTag];
  const chip = Hashtags.getChip(label);
  if (kill) return Hashtags.remove(chip, true);
  chip.selected = !chip.selected;
  Hashtags.toggleChip(chip);  
  Hashtags.onchange();
  return delay();
}
async function flyTo(center, zoom) { // Fly map to specified position/zoom, and return a promise that resolves when complete, with time to resubscribe.
  const {promise:promiseMove, resolve:resolveMove} = Promise.withResolvers();
  const {promise:promiseZoom, resolve:resolveZoom} = Promise.withResolvers();
  map.on('moveend', resolveMove);
  map.on('zoomend', resolveZoom);
  map.flyTo(center, zoom);
  await Promise.all([promiseMove, promiseZoom]);
  map.off('moveend', resolveMove);
  map.off('zoomend', resolveZoom);
  await delay();
}
async function pubSome({payload, act, hashtag, subject, issuedTime, lat = payload.lat, lng = payload.lng}) { // promise to publish to cells containing lat/lng.
  const contact = await networkPromise; 
  const cells = getContainingCells(lat, lng);
  for (const cell of cells) {
    const eventName = makeEventName(cell, hashtag);
    const key = await Node.key(eventName);
    await contact.publish({eventName, key, subject, payload, issuedTime, hashtag, act, immediate: true});
  }
}
async function killSome(tag) { // Kill all existing pub in-scope by tag.
  tag = Hashtags.canonical2extended[tag] || tag;
  const markers = Object.values(Marker.markers);
  const contact = await networkPromise;
  for (const wrapper of markers) {
    if (wrapper.hashtag !== tag) continue;
    const {act, hashtag, subject, replies, lat, lng} = wrapper;
    for (const {act:replier, subject:reply} of replies)
      await contact.publish({eventName: subject, payload: null, act:replier, hashtag, subject: reply});
    await pubSome({payload: null, lat, lng, act, hashtag, subject});
  };
}

async function drop({lat, lng,
		     tag = Hashtags.getPublish(),
		     user = Agent.tag,
		     open = false,
		     issuedTime = Date.now()
		    }) { // Drop a pin labeled by tag (which can be canonical) at position, and return a promise that resolves to subject after a beat.
  const act = user;
  const hashtag = Hashtags.canonical2extended[tag] || tag;
  const subject  = uuidv4();
  const payload = {lat, lng};
  await pubSome({payload, act, hashtag, subject, issuedTime});
  if (open) Marker.openPopup(subject);
  return delay(800, subject);
}
async function gotFile() { // Return a promise that resolves one tick after the file chooser is changed on the current popup (which must be already open).
  // Opening the file chooser must be done manually by the user.
  // The intended usage for scripting is that the recording will capture the user clicking the attachment button to open the chooser.
  const popupElement = map._popup.getElement();
  const fileChooser = popupElement.querySelector('input[type="file"]');
  const {promise, resolve} = Promise.withResolvers();
  fileChooser.addEventListener('change', resolve);
  await promise;
  fileChooser.removeEventListener('change', resolve);
}
async function type(text, input) { // Select input text box in the currently already open popup, enter text, click send, and promise a beat.
  let popupElement;
  if (!input) {
    popupElement = map._popup.getElement();
    input = popupElement.querySelector('.reply-input');
  }
  input.focus();
  await delay(3200);
  const interval = 100;
  for (let index = 0; index < text.length; index++) {
    input.value += text[index];
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true })); // Trigger input handler to resize and enable reply button.
    await delay(interval);
  }
  if (popupElement) popupElement.querySelector('md-filled-icon-button').click();
  else input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  await delay();
}
function addShim() { // Drop a shim over the scene, and return it.
  const shim = document.createElement('div');
  shim.style = "position: absolute; top: 0; width: 100vw; height: 100vh; z-index: 1200; background: black;";
  document.body.append(shim);
  return shim;
}

function announce(text) { // Speak text and return a promise that resolves when done.
  console.log(text);
  let utterance = new SpeechSynthesisUtterance(text);
  const {promise, resolve} = Promise.withResolvers();
  utterance.onend = resolve;
  speechSynthesis.speak(utterance);
  return promise;
}

export { uuidv4, Node, getContainingCells,  delay, positionWatch, networkPromise, disableNotifications, Marker, map, updateLocation, updateSubscriptions, makeEventName, showMessage, Hashtags, Agent, toggle, flyTo, pubSome, killSome, drop, gotFile, type, addShim, announce };
