/*
  import() resolves against the directory that contains the import.
  But NodeJS fs operations resolve against the current working directory from which node was invoked.
  That wasn't terribly inconvenient when require() was used, because it defined __dirname.
  Here we export __dirname and resolve().
  REQUIRES: that this file be imported from this directory.
*/
import path from 'node:path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename); // Only meaningful if loaded from same directory as this file.
export function resolve(relativePathname) {
  return path.resolve(__dirname, relativePathname);
}
