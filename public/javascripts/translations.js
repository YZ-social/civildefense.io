const lang = navigator.language.split('-')[0].toLowerCase(); // Get the language the the user has their browser to.

export function Int([string]) { // A tagged template function that converts to lang.
  // E.g., if the browser lang is 'es', Int`About` => "Acera de", and Int`version` => "Versión"
  let content = translations[string];
  return content?.[lang] || content?.["en"] || string;
}

const translations = {
  About: {es: "Acerca de"},
  ['Your Location']: {es: "Tu Ubicación"},
  ['Tap anywhere to mark a concern. Markers fade after 10 min.']: {es: "Toca cualquier punto para marcar una preocupación. Los marcadores desaparecen después de 10 minutos."},
  ['Location access denied. Using default location.']: {es: "Acceso a la ubicación denegado. Se utilizará la ubicación predeterminada."},
  ['No network connection.']: {es: "Sin conexión de red."},
  ['Geolocation not supported. Using default location.']: {es: "Geolocalización no compatible. Se utilizará la ubicación predeterminada."},
  ['The server connection has closed. Please reload.']: {es: "La conexión con el servidor se ha cerrado. Por favor, recargue la página."},
  ['Connection closed due to inactivity. Will reconnect on use.']: {es: "Conexión cerrada por inactividad. Se reconectará al usarla."},
  ['Getting your location...']: {es: "Obteniendo tu ubicación..."},
  ['Disconnected. Retrying in ']: {es: "Desconectado. Reintentando en "},
  [' seconds.']: {es: " segundos."},
  ['#aboutReport']: {en: "Report immediate concerns to the public by tapping their location on the map.", es: "Informa de cualquier problema inmediato al público pulsando su ubicación en el mapa."},
  ['#aboutShared']: {en: "These locations are shared over anonymous p2p with other users in your area.", es: "Estas ubicaciones se comparten a través de redes P2P anónimas con otros usuarios de tu zona."},
  ['#aboutFade']: {en: "Reported concerns will fade away over 10 minutes.", es: "Las preocupaciones manifestadas se disiparán en 10 minutos."},
  ['#aboutAnyone1']: {en: "A mirror of this app can be", es: "Una réplica de esta aplicación puede ser"},
  ['#aboutAnyone2']: {en: "run by anyone,", es: "administrado por cualquier persona,"},
  ['#aboutAnyone3']: {en: "in case this site is taken down.", es: "en caso de que este sitio sea dado de baja."},
  ['#learnMore']: {en: 'Learn More', es: "Más Información"},
  ['#aboutAcknowledge']: {en: "Yz.social gratefully uses open software from:", es: "Yz.social utiliza con gratitud software libre de:"},
  ['#version']: {en: "Version", es: "Versión"}
};

