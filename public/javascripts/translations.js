const lang = navigator.language.split('-')[0].toLowerCase(); // Get the language the the user has their browser to.

export function Int([string]) { // A tagged template function that converts to lang.
  // E.g., if the browser lang is 'es', Int`Your Location` => "Tu Ubicación", and Int`#version` => "Versión"
  let content = translations[string];
  return content?.[lang] || content?.["en"] || string;
}

const translations = {
  ['Your Location']: {es: "Tu Ubicación"},
  ['Tap anywhere to mark a concern. Markers fade after 24 hours.']: {es: "Toca cualquier punto para marcar una preocupación. Los marcadores desaparecen después de 24 horas."},

  ['Location access denied. Using default location.']: {es: "Acceso a la ubicación denegado. Se utilizará la ubicación predeterminada."},
  ['No network connection.']: {es: "Sin conexión de red."},
  ['Geolocation not supported. Using default location.']: {es: "Geolocalización no compatible. Se utilizará la ubicación predeterminada."},
  ['Unable to get location.']: {es: "No se puede obtener la ubicación."},
  ['The service connection has closed. Please reload.']: {es: "La conexión de servicio se ha cerrado. Por favor, recargue la página."},
  ['Connection closed due to inactivity. Will reconnect on use.']: {es: "Conexión cerrada por inactividad. Se reconectará al usarla."},
  ['Getting your location...']: {es: "Obteniendo tu ubicación..."},
  ['Disconnected. Retrying in ']: {es: "Desconectado. Reintentando en "},
  [' seconds.']: {es: " segundos."},

  ['cake']: {es: "pastel"},
  ['fire']: {es: "fuego"},
  ['flood']: {es: "inundación"},
  ['ice']: {es: "la migra"},
  ['help']: {es: "ayuda"},
  ['add topic']: {es: "añadir tema"},

  ['No additional information.']: {es: "No hay información adicional."},
  ['posted']: {es: "al corriente"},
  ['updated']: {es: "actualizada"},
  ['reply here']: {es: "responder aquí"},
  ['remove']: {es: "eliminar"},
  ['cancel alert']: {es: "Cancelar alerta"},
  ['update']: {es: "actualizar"},
  ['for update to...']: {es: "para actualizar a..."},
  ['In Firefox, sharing must be explicitly enabled through the <a target="civildefense_help" href="https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Experimental_features#webshare_api">dom.webshare.enabled</a> preference in about:config.']: {es: 'En Firefox, la función de compartir debe habilitarse explícitamente mediante la preferencia <a target="civildefense_help" href="https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Experimental_features#webshare_api">dom.webshare.enabled</a> en about:config.'},
  ['This browser does not support sharing.']: {es: "Este navegador no admite la función de compartir."},
  ['This browser does not support file sharing.']: {es: "Este navegador no admite el intercambio de archivos."},
  ['This browser does not support sharing this type of file.']: {es: "Este navegador no admite compartir este tipo de archivo."},

  ['does not support notifications on WebViews embedded in other programs. Please use CivilDefense.io in native']: {es: "no admite notificaciones en WebViews integrados en otros programas. Por favor, utilice CivilDefense.io en el navegador nativo"},
  ['Apple only supports mobile notifications for web pages that have been']: {es: "Apple solo admite notificaciones móviles para páginas web que hayan sido"},
  ['installed to the home screen']: {es: "instaladoi en la pantalla de inicio"},
  ['Enable notifications']: {es: "Habilitar notificaciones"},
  ['Allow notifications']: {es: "Permitir notificaciones"},
  ['Permissions can be re-enabled through the']: {es: "Los permisos se pueden volver a habilitar a través de"},
  ['app']: {es: "Aplicación"},
  ['browser site settings']: {es: "configuración del sitio en el navegador"},
  
  ['#aboutReport']: {en: "Report immediate concerns to the public by tapping their location on the map.", es: "Informa de cualquier problema inmediato al público pulsando su ubicación en el mapa."},
  ['#aboutShared']: {en: "These locations are shared over anonymous p2p with other users in your area.", es: "Estas ubicaciones se comparten a través de redes P2P anónimas con otros usuarios de tu zona."},
  ['#aboutFade']: {en: "Reported concerns will fade away over 24 hours.", es: "Las preocupaciones manifestadas se disiparán en 24 horas."},
  ['#aboutAnyone1']: {en: "A connected mirror of this app can be", es: "Una réplica conectada de esta aplicación puede ser"},
  ['#aboutAnyone2']: {en: "run by anyone,", es: "administrado por cualquier persona,"},
  ['#aboutAnyone3']: {en: "in case this site is taken down.", es: "en caso de que este sitio sea dado de baja."},
  ['#learnMore']: {en: 'Learn More', es: "Más Información"},
  ['#version']: {en: "Version", es: "Versión"},
  ['#checkForUpdates']: {en: "check for updates", es: "Buscar actualizaciones"},
  ['#downloadUpdates']: {en: "install update", es: "Instalar actualización"},
  ['#newVersionHeader']: {en: "New version available", es: "Nueva versión disponible"},
  ['#updateNowQuestion']: {en: "Would you like to update now?", es: "¿Le gustaría actualizar ahora?"},
  ['#updateReload']: {en: "All CivilDefense.io tabs will reload.", es: "Todas las pestañas de CivilDefense.io se recargarán."},
  ['#updateDefer']: {en: "Alternatively, you can update later through the button in About.", es: "Alternativamente, puede actualizar más tarde a través del botón en «Acerca de»."},
  ['#downloadUpdates2']: {en: "yes, update", es: "Sí, actualizar."},
  ['#downloadDefer']: {en: "no, not yet", es: "No, todavía no."},
  ['No update at']: {es: "No hay actualizaciones a las"},
  ['Update available.']: {es: "Actualización disponible."},

  ['#describePrivate1']: {en: "Here are your private labels for", es: "Aquí están sus etiquetas privadas para"},
  ['#describePrivate2']: {en: "to help you recognize posts from them:", es: "Para ayudarte a reconocer publicaciones de ellas:"},
  ['#describePublic']: {en: "The handles that they currently share publicly:", es: "Los nombres de usuario que comparten públicamente en la actualidad:"},
  ['#describeSystem']: {en: "The internal system handles for this person:", es: "El sistema interno gestiona lo siguiente para esta persona:"},
  ['#pickLabels']: {en: "You can pick the labels you like, or securely capture any of the following...", es: "Puede elegir las etiquetas que prefiera o capturar de forma segura cualquiera de las siguientes..."},
  ['handle']: {es: "el título"},
  ['your handle']: {es: "tu título"}
};
