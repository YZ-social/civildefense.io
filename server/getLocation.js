/*
  Exports the current estimated location, based on IP address.
  The value is cached in location.json, which can also be hand-edited, cleared, etc.
 */
import fs from 'fs/promises';
import { resolve } from './dirname.js';
const filename = './location.json';
export const data = await import(filename, {with: { type: 'json' }})
  .catch(async error => {
    console.log(error);
    const response = await fetch('https://ipinfo.io/json');
    const string = await response.text();
    console.log('Estimating location as', string);
    await fs.writeFile(resolve(filename), string, 'utf8');
    return {default: JSON.parse(string)};
  });
export const [lat, lng] = data.default.loc.split(',').map(parseFloat);
export const location = {lat, lng};

