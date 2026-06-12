// ==========================================================================
// server_capelli.js — SERVIDOR EXCLUSIVO E INDEPENDIENTE DE CAPELLI
// Versión con "aduana" bidireccional: verifica pertenencia contra Firestore
// y reenvía a BarberGo lo que no le corresponde (en vez de ignorarlo).
// ==========================================================================

const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');
const cron    = require('node-cron');

const serviceAccount = require('/etc/secrets/firebase-key.json');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db  = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

// ========================================
// VARIABLES DE ENTORNO (Exclusivas Capelli)
// ========================================
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // Debe ser 1117444051458463
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;    // capelli_token_seguro
const PORT            = process.env.PORT || 10000;

// Identificadores de la base de datos para aislar la data
const COMPANY_ID   = 'nI6ilcu8qPbH3xiXXsM7';
const LOCATION_IDS = ['2OaikKXImqJbfPaqXfG6']; // 👈 si Capelli abre otra sucursal, agregar acá

// Servidor de BarberGo (para reenviar lo que NO es de Capelli)
const BARBERGO_SERVER_URL = process.env.BARBERGO_SERVER_URL || 'https://barbergo-whatsapp-api.onrender.com';

// ========================================
// PLANTILLAS EXCLUSIVAS DE CAPELLI
// ========================================
const TEMPLATES = {
  solicitud:      'solicitud_reserva_capelli_v1',
  confirmada:     'reserva_confirmada_capelli_v1',
  cancelada:      'reserva_cancelada_capelli_v1',
  recordatorio:   'recordatorio_turno_capelli_v1',
  calificacion:   'calificar_barbero_capelli_v1',
  agradecimiento: 'agradecimiento_capelli_v1'
};

// ==========================================================================
// 🚦 ADUANA: ¿Esta reserva/petición pertenece a Capelli?
// Verificación en cascada: companyId → locationId conocido → Firestore.
// Esto cubre reservas viejas que NO tienen companyId guardado.
// ==========================================================================
async function perteneceACapelli({ companyId, locationId, booking } = {}) {
  const comp = String(companyId || booking?.companyId || '').trim();
  const loc  = String(locationId || booking?.locationId || '').trim();

  if (comp === COMPANY_ID) return true;
  if (loc && LOCATION_IDS.includes(loc)) return true;

  if (loc) {
    try {
      const snap = await db.collection('locations').doc(loc).get();
      if (snap.exists && String(snap.data().companyId || '').trim() === COMPANY_ID) {
        return true;
      }
    } catch (e) {
      console.error('⚠️ [Capelli Router] Error verificando location:', e.message);
    }
  }
  return false;
}

/**
 * Reenvía a BarberGo lo que no pertenece a Capelli.
 * Garantiza que ningún mensaje se pierda ni salga del número equivocado.
 */
async function reenviarABarberGo(path, body, res) {
  console.log(`↪️  [Relay] Petición que NO es de Capelli. Reenviando a ${BARBERGO_SERVER_URL}${path}`);
  try {
    const r = await fetch(`${BARBERGO_SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json({ ...data, relayedTo: 'barbergo' });
  } catch (e) {
    console.error('❌ [Relay] No se pudo contactar al servidor de BarberGo:', e.message);
    return res.status(502).json({ success: false, error: 'No se pudo contactar al servidor de BarberGo', relayedTo: 'barbergo' });
  }
}

// ========================================
// HELPERS
// ========================================
function normalizarNumeroPY(phone) {
  let n = String(phone || '').replace(/\D/g, '');
  if (n.startsWith('0'))         n = '595' + n.substring(1);
  else if (!n.startsWith('595')) n = '595' + n;
  return n;
}

function numeroMetaALocal(numeroMeta) {
  if (String(numeroMeta).startsWith('595')) return '0' + String(numeroMeta).substring(3);
  return String(numeroMeta || '');
}

async function esPremium(reserva) {
  try {
    const companyId = reserva.companyId || COMPANY_ID;
    const companySnap = await db.collection('companies').doc(companyId).get();
    if (companySnap.exists) {
      const plan = companySnap.data().plan || '';
      return plan.toLowerCase() === 'premium';
    }
  } catch (error) {
    console.error('❌ Error verificando plan premium:', error);
  }
  return false;
}

async function obtenerDatosUbicacion(locationId) {
  const defaults = { shopName: 'Capelli', mapLink: 'https://maps.app.goo.gl/tu-local', shopUrl: 'https://app.barbergo.com.py' };
  const loc = String(locationId || '').trim();
  if (!loc) return defaults;

  try {
    const snap = await db.collection('locations').doc(loc).get();
    if (snap.exists) {
      const d = snap.data();
      return {
        shopName: (d.name || defaults.shopName).trim(),
        mapLink:  d.mapUrl || defaults.mapLink,
        shopUrl:  d.slug ? `https://app.barbergo.com.py/${d.slug}` : defaults.shopUrl
      };
    }
  } catch (e) { console.error('❌ Error ubicación:', e); }
  return defaults;
}

function formatearReserva(reserva) {
  const dateObj = new Date(reserva.date + 'T00:00:00');
  const formattedDate = dateObj
    .toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })
    .replace(',', '');
  const clientName   = reserva.client?.name  || 'Cliente';
  const timeStr      = reserva.startTime     || reserva.time || '';
  const barberName   = reserva.barber?.name  || 'Barbero asignado';
  const groupId      = reserva.bookingGroupId || reserva.id || '';
  const tId          = groupId ? String(groupId).slice(-5) : '-----';
  const serviceName  = reserva.services?.length > 0 ? reserva.services.map(s => s.name).join(', ') : 'Servicio de barbería';
  const servicePrice = reserva.totalPrice || '0';
  return { clientName, timeStr, barberName, groupId, tId, serviceName, servicePrice, formattedDate };
}

// ========================================
// ENVÍO DE PLANTILLAS (META GRAPH API)
// ========================================
async function enviarTemplate(numero, templateName, params = []) {
  try {
    const components = params.length > 0
      ? [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }]
      : [];

    const body = {
      messaging_product: 'whatsapp',
      to: numero,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'es' },
        components
      }
    };

    console.log(`📤 [Capelli] Enviando '${templateName}' a ${numero} (PHONE_NUMBER_ID: ${PHONE_NUMBER_ID})...`);

    const resp = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const data = await resp.json();
      // ⚠️ Mientras las plantillas Capelli estén PENDIENTES en Meta,
      // acá vas a ver error 132001 (template no existe/no aprobada).
      // Eso confirma que el SERVIDOR y la PLANTILLA son los correctos:
      // cuando Meta apruebe las plantillas, empezarán a salir solas.
      console.error(`❌ [Capelli] Error de Meta [${templateName}]:`, JSON.stringify(data));
      return false;
    }

    console.log(`✅ [Capelli] Template '${templateName}' enviado a ${numero}`);
    return true;
  } catch (error) {
    console.error(`❌ [Capelli] Error enviando template '${templateName}':`, error);
    return false;
  }
}

// ========================================
// MENSAJES DE NEGOCIO
// ========================================
async function enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta) {
  const { shopName, mapLink, shopUrl } = await obtenerDatosUbicacion(reserva.locationId);
  const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);
  const templateName = nuevoEstado === 'confirmed' ? TEMPLATES.confirmada : TEMPLATES.cancelada;
  const linkFinal    = nuevoEstado === 'confirmed' ? mapLink : shopUrl;
  await enviarTemplate(numeroMeta, templateName, [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, linkFinal]);
}

async function enviarRecordatorioWhatsApp(reserva) {
  const { shopName, mapLink } = await obtenerDatosUbicacion(reserva.locationId);
  const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);
  const cleanPhone = normalizarNumeroPY(reserva.client?.phone);
  await enviarTemplate(cleanPhone, TEMPLATES.recordatorio, [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, mapLink]);
}

async function enviarCalificacionWhatsApp(reserva) {
  const cleanPhone = normalizarNumeroPY(reserva.client?.phone);
  if (!cleanPhone) return;
  const { shopName } = await obtenerDatosUbicacion(reserva.locationId);
  await enviarTemplate(cleanPhone, TEMPLATES.calificacion, [reserva.client?.name || 'Cliente', shopName, reserva.barber?.name || 'tu barbero']);
}

async function enviarAgradecimientoWhatsApp(reserva, telefonoLocal) {
  try {
    const snap = await db.collection('companies').doc(COMPANY_ID).get();
    if (!snap.exists || snap.data().plan?.toLowerCase() !== 'premium') return;
  } catch (e) { return; }
  await enviarTemplate(normalizarNumeroPY(telefonoLocal), TEMPLATES.agradecimiento, []);
}

// ========================================
// RUTAS
// ========================================
app.get('/', (req, res) => res.status(200).json({ ok: true, message: 'Capelli WhatsApp API activa y aislada', role: 'capelli' }));

// --------------------------------------------------------------------------
// /api/enviar-mensaje — CON ADUANA Y TRADUCTOR DE PLANTILLAS
// --------------------------------------------------------------------------
app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [], locationId, companyId } = req.body;

    if (!phone || !templateName) {
      return res.status(400).json({ success: false, error: 'phone y templateName son obligatorios' });
    }

    // 🚦 ADUANA: si el frontend mandó companyId/locationId y NO es de Capelli,
    // esta petición no nos corresponde → reenviar a BarberGo.
    if ((companyId || locationId) && !(await perteneceACapelli({ companyId, locationId }))) {
      return reenviarABarberGo('/api/enviar-mensaje', req.body, res);
    }

    // 🔄 TRADUCTOR: si llega un nombre de plantilla de BarberGo,
    // lo convertimos a su equivalente Capelli automáticamente.
    const TEMPLATE_MAP = {
      'solicitud_reserva_v3':    TEMPLATES.solicitud,
      'reserva_confirmada_v2':   TEMPLATES.confirmada,
      'reserva_cancelada_v3':    TEMPLATES.cancelada,
      'recordatorio_turno_v3':   TEMPLATES.recordatorio,
      'recordatorio_turno_v4':   TEMPLATES.recordatorio,
      'calificar_barbero_v2':    TEMPLATES.calificacion,
      'agradecimiento_v1':       TEMPLATES.agradecimiento
    };

    const resolvedTemplate = TEMPLATE_MAP[templateName] || templateName;
    const cleanPhone = normalizarNumeroPY(phone);
    const ok = await enviarTemplate(cleanPhone, resolvedTemplate, params);

    return res.status(ok ? 200 : 500).json({ success: ok, templateUsed: resolvedTemplate, sentBy: 'capelli' });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// --------------------------------------------------------------------------
// /api/reserva-completada — CON ADUANA (decide con la reserva REAL de Firestore)
// --------------------------------------------------------------------------
app.post('/api/reserva-completada', async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) return res.status(400).json({ success: false, error: 'Falta bookingId' });

    const bookingRef  = db.collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) return res.status(404).json({ success: false, error: 'Reserva no encontrada' });

    const realBooking = bookingSnap.data();

    // 🚦 ADUANA: si NO es de Capelli → reenviar a BarberGo (antes solo se ignoraba)
    if (!(await perteneceACapelli({ booking: realBooking }))) {
      return reenviarABarberGo('/api/reserva-completada', req.body, res);
    }

    if (!realBooking.isPrimary || realBooking.ratingTemplateSent) {
      return res.status(200).json({ success: true, message: 'Ya procesado o no es primario' });
    }

    const premium = await esPremium(realBooking);
    if (!premium) {
      await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'No es cuenta Premium' });
    }

    console.log(`💈 [Capelli] Cuenta PREMIUM. Solicitando calificación con: ${TEMPLATES.calificacion}`);
    await enviarCalificacionWhatsApp(realBooking);
    await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });

    return res.status(200).json({ success: true, message: 'Solicitud de calificación enviada', sentBy: 'capelli' });
  } catch (error) {
    console.error('❌ Error en /api/reserva-completada:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// --------------------------------------------------------------------------
// /api/admin-notificar-cancelacion — CON ADUANA (espejo de BarberGo)
// --------------------------------------------------------------------------
app.post('/api/admin-notificar-cancelacion', async (req, res) => {
  try {
    const { reserva } = req.body;

    if (!reserva || !reserva.client || !reserva.client.phone) {
      return res.status(400).json({ success: false, error: 'Faltan datos de la reserva o del cliente' });
    }

    if (!(await perteneceACapelli({ booking: reserva }))) {
      return reenviarABarberGo('/api/admin-notificar-cancelacion', req.body, res);
    }

    const numeroMeta = normalizarNumeroPY(reserva.client.phone);
    await enviarRespuestaWhatsApp(reserva, 'cancelled', numeroMeta);

    return res.status(200).json({ success: true, message: 'Mensaje de cancelación enviado', sentBy: 'capelli' });
  } catch (error) {
    console.error('❌ Error en /api/admin-notificar-cancelacion:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ========================================
// WEBHOOK META (Aislado por phone_number_id)
// ========================================
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // 🛑 FILTRO DE ORO: solo mensajes que llegaron al número de Capelli
        if (value.metadata?.phone_number_id !== PHONE_NUMBER_ID) continue;
        if (!value.messages) continue;

        for (const mensaje of value.messages) {
          const numeroMeta    = mensaje.from || '';
          const telefonoLocal = numeroMetaALocal(numeroMeta);
          let respuestaCliente = '';

          if (mensaje.type === 'text')        respuestaCliente = mensaje.text?.body?.toLowerCase()?.trim() || '';
          else if (mensaje.type === 'button') respuestaCliente = mensaje.button?.text?.toLowerCase()?.trim() || '';
          else if (mensaje.type === 'interactive') {
            respuestaCliente = mensaje.interactive?.button_reply?.title?.toLowerCase()?.trim() ||
              mensaje.interactive?.list_reply?.title?.toLowerCase()?.trim() || '';
          }

          console.log(`📞 [Capelli] Mensaje entrante de: ${numeroMeta} | Texto: "${respuestaCliente}"`);

          // 1. Calificación 1-5 (sesiones separadas de la DB)
          const ratingMatch = respuestaCliente.trim().match(/^[1-5]$/);
          if (ratingMatch) {
            const stars = parseInt(ratingMatch[0]);
            await db.collection('rating_sessions_capelli').doc(telefonoLocal).set({
              stars, phone: telefonoLocal, companyId: COMPANY_ID,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              expiresAt: new Date(Date.now() + 10 * 60 * 1000)
            });
            continue;
          }

          // 2. Comentario de calificación
          const sessionSnap = await db.collection('rating_sessions_capelli').doc(telefonoLocal).get();
          if (sessionSnap.exists) {
            const session = sessionSnap.data();
            const expiresAt = session.expiresAt?.toDate ? session.expiresAt.toDate() : new Date(session.expiresAt);
            if (new Date() < expiresAt) {
              const { stars } = session;
              const comment = respuestaCliente.trim();
              await db.collection('rating_sessions_capelli').doc(telefonoLocal).delete();

              const snapshot = await db.collection('bookings')
                .where('client.phone', '==', telefonoLocal)
                .where('locationId', 'in', LOCATION_IDS)
                .where('status', '==', 'completed')
                .orderBy('createdAt', 'desc').limit(3).get();

              const bookingDoc = snapshot.docs.find(d => !d.data().isReviewed);
              if (!bookingDoc) continue;

              const booking    = bookingDoc.data();
              const locationId = booking.locationId ? String(booking.locationId).trim() : null;
              const barberId   = booking.barber?.id  ? String(booking.barber.id).trim()  : null;
              if (!locationId || !barberId) { await bookingDoc.ref.update({ isReviewed: true }); continue; }

              let barberRef = null;
              const directSnap = await db.collection('locations').doc(locationId).collection('barbers').doc(barberId).get();
              if (directSnap.exists) {
                barberRef = directSnap.ref;
              } else {
                // Búsqueda flexible por campo 'id' (igual que BarberGo)
                for (const idValue of [Number(barberId), barberId]) {
                  const q = await db.collection('locations').doc(locationId).collection('barbers').where('id', '==', idValue).limit(1).get();
                  if (!q.empty) { barberRef = q.docs[0].ref; break; }
                }
              }
              if (!barberRef) { await bookingDoc.ref.update({ isReviewed: true }); continue; }

              await db.runTransaction(async (t) => {
                const barberDoc = await t.get(barberRef);
                if (!barberDoc.exists) return;
                const curr = barberDoc.data().rating || 0;
                const count = barberDoc.data().reviewsCount || 0;
                const newCount = count + 1;
                t.update(barberRef, { rating: parseFloat(((curr * count + stars) / newCount).toFixed(1)), reviewsCount: newCount });
                t.update(bookingDoc.ref, { isReviewed: true, reviewStars: stars, reviewComment: comment });
                t.set(barberRef.collection('reviews').doc(bookingDoc.id), {
                  clientId: booking.userId || telefonoLocal, clientName: booking.client?.name || 'Cliente',
                  stars: Number(stars), comment, createdAt: admin.firestore.FieldValue.serverTimestamp(), bookingId: bookingDoc.id
                });
              });
              await enviarAgradecimientoWhatsApp(booking, telefonoLocal);
              continue;
            }
            await db.collection('rating_sessions_capelli').doc(telefonoLocal).delete();
          }

          // 3. Confirmación / Cancelación
          const palabras = respuestaCliente.split(/[\s,.!?;:()]+/).filter(Boolean);
          const esConfirmar = palabras.some(p => ['si','sí','sii','siii','ok','okey','dale','voy','asisto','perfecto','excelente','seguro'].includes(p)) || respuestaCliente.includes('confirm');
          const esCancelar  = palabras.some(p => ['no','imposible'].includes(p)) || respuestaCliente.includes('cancel') || respuestaCliente.includes('no voy') || respuestaCliente.includes('me complico');

          let nuevoEstado = null;
          if (esCancelar)       nuevoEstado = 'cancelled';
          else if (esConfirmar) nuevoEstado = 'confirmed';
          if (!nuevoEstado) continue;

          const estadosValidos = nuevoEstado === 'confirmed' ? ['pending'] : ['pending', 'confirmed'];
          const snap = await db.collection('bookings')
            .where('client.phone', '==', telefonoLocal)
            .where('locationId', 'in', LOCATION_IDS)
            .where('status', 'in', estadosValidos)
            .orderBy('createdAt', 'desc').limit(1).get();

          if (snap.empty) continue;

          const reservaDoc = snap.docs[0];
          const reserva    = reservaDoc.data();
          if (nuevoEstado === 'confirmed' && reserva.status === 'confirmed') continue;

          const groupId = reserva.bookingGroupId;
          if (!groupId) {
            await db.collection('bookings').doc(reservaDoc.id).update({ status: nuevoEstado, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          } else {
            const bloquesSnap = await db.collection('bookings').where('bookingGroupId', '==', groupId).get();
            const batch = db.batch();
            bloquesSnap.forEach(d => batch.update(d.ref, { status: nuevoEstado, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
            await batch.commit();
          }

          await enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta);
        }
      }
    }
  } catch (error) {
    console.error('❌ [Capelli] Error webhook:', error);
  }
});

// ========================================
// CRON: RECORDATORIOS 2HS ANTES
// ========================================
cron.schedule('*/15 * * * *', async () => {
  try {
    const now      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Asuncion' }));
    const todayStr = now.toISOString().split('T')[0];

    const snapshot = await db.collection('bookings')
      .where('date', '==', todayStr)
      .where('locationId', 'in', LOCATION_IDS)
      .where('status', '==', 'confirmed')
      .where('reminderSent', '==', false).get();

    for (const doc of snapshot.docs) {
      const reserva = doc.data();
      const timeStr = reserva.startTime || reserva.time;
      if (!timeStr) continue;
      const [h, m] = timeStr.split(':').map(Number);
      const bookingTime = new Date(now);
      bookingTime.setHours(h, m, 0, 0);
      const diffMinutes = Math.floor((bookingTime - now) / 60000);

      if (diffMinutes >= 105 && diffMinutes <= 135) {
        await db.collection('bookings').doc(doc.id).update({ reminderSent: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        await enviarRecordatorioWhatsApp(reserva);
      }
    }
  } catch (error) {
    console.error('❌ [Capelli CRON] Error:', error);
  }
});

// ========================================
// NOTIFICACIONES PUSH FCM
// (mismo proyecto Firebase, no necesita aduana)
// ========================================
app.post('/api/notificar-reserva', async (req, res) => {
  const { tokens, title, body, data } = req.body;
  if (!tokens || tokens.length === 0) return res.status(400).json({ error: 'Sin tokens' });

  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: title || '¡Nueva Reserva! 💈', body: body || 'Nuevo turno agendado' },
      data: {
        title: title || '¡Nueva Reserva! 💈',
        body: body || 'Nuevo turno agendado',
        bookingId: data?.bookingId || '',
        locationId: data?.locationId || ''
      },
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'barbergo_reservas', tag: data?.bookingId || 'nueva-reserva' }
      },
      webpush: {
        headers: { Urgency: 'high' },
        notification: { tag: data?.bookingId || 'nueva-reserva', renotify: false }
      }
    });

    res.json({ success: true, enviados: response.successCount });
  } catch (error) {
    console.error('❌ Error FCM Capelli:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Capelli WhatsApp API activa y separada en puerto ${PORT}`);
  console.log(`🚦 Relay configurado hacia BarberGo: ${BARBERGO_SERVER_URL}`);
});