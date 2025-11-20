const lang = navigator.language.split('-')[0].toLowerCase();

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
  ['Server unavailable. Retrying in ']: {es: "Servidor no disponible. Reintentando en "},
  [' seconds, or reload.']: {es: " segundos o recargando la página."},
  ['#aboutReport']: {en: "Report immediate concerns to the public by tapping their location on the map.", es: "Informa de cualquier problema inmediato al público pulsando su ubicación en el mapa."},
  ['#aboutShared']: {en: "These locations are shared over anonymous p2p with other users in your area.", es: "Estas ubicaciones se comparten a través de redes P2P anónimas con otros usuarios de tu zona."},
  ['#aboutFade']: {en: "Reported concerns will fade away over 10 minutes.", es: "Las preocupaciones manifestadas se disiparán en 10 minutos."},
  ['#aboutMirror']: {en: "A mirror of this app", es: "Una réplica de esta aplicación"},
  ['#aboutAnyone']: {en: "can be run by anyone, in case this site is taken down.", es: "puede ser administrado por cualquier persona, en caso de que este sitio sea dado de baja."},
  ['#aboutYz']: {en: "YZ.social is building a totally free and open source, fully secure, peer-to-peer network for a new class of applications. The YZ network has no servers, no central database, no single point of failure. It is a true, fully decentralized network constructed, controlled and owned by its users. YZ Alert (Wise Alert) is the first application built on the YZ network.",
		 es: "YZ.social está creando una red peer-to-peer totalmente gratuita, de código abierto y completamente segura para una nueva generación de aplicaciones. La red YZ no tiene servidores, ni base de datos central, ni un único punto de fallo. Es una red verdaderamente descentralizada, construida, controlada y propiedad de sus usuarios. YZ Alert (Alerta Inteligente) es la primera aplicación desarrollada en la red YZ."},
  ['#aboutAcknowledge']: {en: "Yz.social gratefully uses open software from:", es: "Yz.social utiliza con gratitud software libre de:"},
  ['#version']: {en: "Version", es: "Versión"}
};

export function Int([string]) {
  let content = translations[string];
  return content?.[lang] || content?.["en"] || string;
}
