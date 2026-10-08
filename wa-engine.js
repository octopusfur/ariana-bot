"use strict";
// Picks the WhatsApp sidecar. Default stays whatsapp-web.js until you opt in: set WA_ENGINE=whatsmeow on Render.
// If whatsmeow's handshake gets rejected from Render, delete WA_ENGINE and nothing is lost.
require(process.env.WA_ENGINE === "whatsmeow" ? "./wa-meow.js" : "./wa-web.js");
