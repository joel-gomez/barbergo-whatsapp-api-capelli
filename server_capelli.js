// ==========================================================================
// server_capelli.js — SERVIDOR EXCLUSIVO E INDEPENDIENTE DE CAPELLI
// ==========================================================================

const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');
const cron    = require('node-cron');

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db  = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const PORT            = process.env.PORT || 10000;

const COMPANY_ID   = 'nI6ilcu8qPbH3xiXXsM7';
const LOCATION_IDS = ['20aikKXImqJbfPaqXfG6'];

const BARBERGO_SERVER_URL = process.env.BARBERGO_SERVER_URL || 'https://barbergo-whatsapp-api-production.up.railway.app';

const TEMPLATES = {
  solicitud:      'solicitud_reserva_capelli_v1',
  confirmada:     'reserva_confirmada_capelli_v1',
  cancelada:      'reserva_cancelada_capelli_v1',
  recordatorio:   'recordatorio_turno_capelli_v1',
  calificacion:   'calificar_barbero_capelli_v1',
  agradecimiento: 'agradecimiento_capelli_v1'
};

// =====================================================================
// 🕐 HORA DE PARAGUAY — UTC-3 FIJO
// ---------------------------------------------------------------------
// ⚠️ Mismo bug que se encontró y arregló en barbergo-whatsapp-api
// (server.js principal): el tzdata del contenedor de Railway está
// desactualizado y todavía aplica la regla VIEJA de horario de verano/
// invierno de Paraguay — pero esa regla se eliminó por ley (Ley 7354)
// en octubre de 2024. Paraguay es UTC-3 fijo, todo el año, sin cambios.
// Usar Intl/toLocaleString con 'America/Asuncion' da la hora ~1h
// atrasada en invierno. Por eso acá SIEMPRE se calcula con offset fijo
// en vez de depender de la zona horaria del sistema.
// =====================================================================
const PY_OFFSET_MIN = -180; // UTC-3

function _ahoraPY(offsetDias = 0) {
  return new Date(Date.now() + PY_OFFSET_MIN * 60 * 1000 + offsetDias * 86400000);
}

function fechaPY(offsetDias = 0) {
  const d = _ahoraPY(offsetDias);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function horaParaguay() {
  const d = _ahoraPY();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return {
    dateStr: fechaPY(),
    hour, minute,
    minutosDelDia: hour * 60 + minute,
    timeStr: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

// Positivo = falta para el turno | Negativo = el turno ya pasó
function minutosHastaTurno(startTimeStr, pyNow) {
  if (!startTimeStr) return null;
  const [h, m] = startTimeStr.split(':').map(Number);
  return (h * 60 + m) - pyNow.minutosDelDia;
}

// =====================================================================
// 📡 ALCANCE COMPARTIDO DEL PORTFOLIO DE META (clientes únicos / 24hs)
// ---------------------------------------------------------------------
// Capelli y el bot compartido de BarberGo viven en el MISMO Business
// Portfolio de Meta → comparten el MISMO límite de alcance (clientes
// únicos contactados con mensajes que NOSOTROS iniciamos, en una
// ventana móvil de 24hs). Este helper escribe en la MISMA colección
// `meta_reach_daily` que usa server.js (mismo proyecto de Firebase),
// así el conteo sale combinado entre los dos servers sin que ninguno
// tenga que saber nada del otro. Ver comentario completo en server.js.
// Solo visibilidad, no bloqueo — es aproximado (día calendario PY, no
// la ventana móvil exacta de Meta).
// =====================================================================
async function registrarAlcanceMeta(phone) {
  try {
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone) return;
    const hoy = fechaPY();
    await db.collection('meta_reach_daily').doc(hoy).set({
      numeros: { [cleanPhone]: admin.firestore.FieldValue.serverTimestamp() },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.error('⚠️ [Capelli] [Alcance Meta] No se pudo registrar:', e.message);
  }
}

// =====================================================================
// 💳 CUPO MENSUAL DE MENSAJES DE CAPELLI
// ---------------------------------------------------------------------
// Capelli tiene un límite propio negociado (2000/mes), distinto de los
// planes estándar basic/premium/empresarial del server.js compartido.
// Se guarda en la MISMA colección `usage_monthly` que usa el server
// principal (mismo formato de doc: monthly_{companyId}_{YYYY-MM}) —
// así el panel "Uso WhatsApp" del SuperAdmin lo muestra automáticamente,
// sin ningún cambio adicional ahí.
//
// Mismo patrón de seguridad que en server.js:
// - puedeEnviar()  → SOLO LECTURA, nunca incrementa el contador.
// - consumirCupo() → transacción que incrementa, se llama SOLO después
//   de que Meta aceptó el mensaje (nunca se descuenta cupo por un envío
//   que falló, se omitió o fue bloqueado).
//
// El límite se puede ajustar desde Railway con la variable de entorno
// WHATSAPP_MENSUAL_LIMIT, sin tocar código ni redeployar.
// =====================================================================
const WHATSAPP_MENSUAL_LIMIT = parseInt(process.env.WHATSAPP_MENSUAL_LIMIT || '2000', 10);

async function puedeEnviar(companyId = COMPANY_ID) {
  const mesActual = fechaPY().slice(0, 7);
  try {
    const snap = await db.collection('usage_monthly').doc(`monthly_${companyId}_${mesActual}`).get();
    const actual = snap.exists ? (snap.data().count || 0) : 0;
    if (actual >= WHATSAPP_MENSUAL_LIMIT) return { permitido: false, motivo: 'limite_mensual_capelli' };
    return { permitido: true, motivo: 'capelli_ok', count: actual, limit: WHATSAPP_MENSUAL_LIMIT };
  } catch (e) {
    console.error('❌ [Capelli] Error en puedeEnviar:', e.message);
    return { permitido: true, motivo: 'error_check' };
  }
}

async function consumirCupo(companyId = COMPANY_ID) {
  const mesActual = fechaPY().slice(0, 7);
  const ref = db.collection('usage_monthly').doc(`monthly_${companyId}_${mesActual}`);
  try {
    const r = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const actual = snap.exists ? (snap.data().count || 0) : 0;
      if (actual >= WHATSAPP_MENSUAL_LIMIT) return { consumido: false, count: actual };
      t.set(ref, {
        companyId,
        plan: 'empresarial', // Capelli opera a nivel empresarial, con límite propio más alto
        mes: mesActual,
        count: actual + 1,
        limit: WHATSAPP_MENSUAL_LIMIT,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { consumido: true, count: actual + 1 };
    });
    if (r.consumido) console.log(`📊 [Capelli] usa ${r.count}/${WHATSAPP_MENSUAL_LIMIT} msgs este mes.`);
    else console.log(`🚫 [Capelli] Sin cupo al consumir (${r.count}/${WHATSAPP_MENSUAL_LIMIT}).`);
    return r;
  } catch (e) {
    console.error('❌ [Capelli] Error en consumirCupo:', e.message);
    return { consumido: false };
  }
}

async function perteneceACapelli({ companyId, locationId, booking } = {}) {
  const comp = String(companyId || booking?.companyId || '').trim();
  const loc  = String(locationId || booking?.locationId || '').trim();
  if (comp === COMPANY_ID) return true;
  if (loc && LOCATION_IDS.includes(loc)) return true;
  if (loc) {
    try {
      const snap = await db.collection('locations').doc(loc).get();
      if (snap.exists && String(snap.data().companyId || '').trim() === COMPANY_ID) return true;
    } catch (e) { console.error('⚠️ [Capelli Router] Error verificando location:', e.message); }
  }
  return false;
}

async function reenviarABarberGo(path, body, res) {
  console.log(`↪️  [Relay] Reenviando a ${BARBERGO_SERVER_URL}${path}`);
  try {
    const r = await fetch(`${BARBERGO_SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json({ ...data, relayedTo: 'barbergo' });
  } catch (e) {
    console.error('❌ [Relay] No se pudo contactar a BarberGo:', e.message);
    return res.status(502).json({ success: false, error: 'No se pudo contactar a BarberGo' });
  }
}

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

async function esEmpresarial(reserva) {
  try {
    const companyId = reserva.companyId || COMPANY_ID;
    const companySnap = await db.collection('companies').doc(companyId).get();
    if (companySnap.exists) {
      const plan = companySnap.data().plan || '';
      return plan.toLowerCase() === 'empresarial' || plan.toLowerCase() === 'premium';
    }
  } catch (error) {
    console.error('❌ Error verificando plan:', error);
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
  const formattedDate = dateObj.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  const clientName   = reserva.client?.name  || 'Cliente';
  const timeStr      = reserva.startTime     || reserva.time || '';
  const barberName   = reserva.barber?.name  || 'Barbero asignado';
  const groupId      = reserva.bookingGroupId || reserva.id || '';
  const tId          = groupId ? String(groupId).slice(-5) : '-----';
  const serviceName  = reserva.services?.length > 0 ? reserva.services.map(s => s.name).join(', ') : 'Servicio de barbería';
  const servicePrice = reserva.totalPrice || '0';
  return { clientName, timeStr, barberName, groupId, tId, serviceName, servicePrice, formattedDate };
}

// =====================================================================
// 📤 ENVIAR TEMPLATE
// - skipLimitCheck: salta el chequeo previo (el caller ya validó con puedeEnviar)
// - El cupo se descuenta SOLO si Meta aceptó el mensaje (consumirCupo al final)
// =====================================================================
async function enviarTemplate(numero, templateName, params = [], companyId = COMPANY_ID, skipLimitCheck = false, esIniciadoPorNegocio = true) {
  if (!skipLimitCheck) {
    const { permitido, motivo } = await puedeEnviar(companyId);
    if (!permitido) { console.log(`🚫 [Capelli] Bloqueado (${motivo})`); return false; }
  }
  try {
    const components = params.length > 0
      ? [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }]
      : [];
    const body = {
      messaging_product: 'whatsapp', to: numero, type: 'template',
      template: { name: templateName, language: { code: 'es' }, components }
    };
    console.log(`📤 [Capelli] Enviando '${templateName}' a ${numero}...`);
    const resp = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      console.error(`❌ [Capelli] Error Meta [${templateName}]:`, JSON.stringify(data));
      return false; // ❌ Meta rechazó → NO se consume cupo
    }
    console.log(`✅ [Capelli] Template '${templateName}' enviado a ${numero}`);
    await consumirCupo(companyId); // ✅ recién ahora, con el mensaje aceptado, descontamos 1 crédito
    // 📡 Solo cuenta para el alcance compartido de Meta si lo iniciamos nosotros
    // (ver comentario de registrarAlcanceMeta más arriba)
    if (esIniciadoPorNegocio) await registrarAlcanceMeta(numero);
    return true;
  } catch (error) {
    console.error(`❌ [Capelli] Error enviando '${templateName}':`, error);
    return false;
  }
}

async function enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta, esIniciadoPorNegocio = true) {
  const { shopName, mapLink, shopUrl } = await obtenerDatosUbicacion(reserva.locationId);
  const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);
  const templateName = nuevoEstado === 'confirmed' ? TEMPLATES.confirmada : TEMPLATES.cancelada;
  const linkFinal    = nuevoEstado === 'confirmed' ? mapLink : shopUrl;
  await enviarTemplate(numeroMeta, templateName, [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, linkFinal], COMPANY_ID, false, esIniciadoPorNegocio);
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
    if (!snap.exists) return;
    const plan = snap.data().plan?.toLowerCase() || '';
    if (plan !== 'empresarial' && plan !== 'premium') return;
  } catch (e) { return; }
  // Siempre es respuesta a un comentario del cliente → dentro de ventana de servicio, no cuenta para Meta
  await enviarTemplate(normalizarNumeroPY(telefonoLocal), TEMPLATES.agradecimiento, [], COMPANY_ID, false, false);
}

// ========================================
// RUTAS
// ========================================
app.get('/', (req, res) => res.status(200).json({ ok: true, message: 'Capelli WhatsApp API activa', role: 'capelli' }));

app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [], locationId, companyId } = req.body;
    if (!phone || !templateName) return res.status(400).json({ success: false, error: 'phone y templateName son obligatorios' });

    if ((companyId || locationId) && !(await perteneceACapelli({ companyId, locationId }))) {
      return reenviarABarberGo('/api/enviar-mensaje', req.body, res);
    }

    const cid = companyId || COMPANY_ID;

    // Chequeo de cupo SOLO LECTURA antes de intentar mandar
    const { permitido, motivo } = await puedeEnviar(cid);
    if (!permitido) {
      console.log(`🚫 [Capelli] Bloqueado (${motivo})`);
      return res.status(200).json({ success: false, blocked: motivo, sentBy: 'capelli' });
    }

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
    // skipLimitCheck=true: ya validamos arriba, enviarTemplate solo descuenta si Meta acepta
    const ok = await enviarTemplate(cleanPhone, resolvedTemplate, params, cid, true);
    return res.status(ok ? 200 : 500).json({ success: ok, templateUsed: resolvedTemplate, sentBy: 'capelli' });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// --------------------------------------------------------------------------
// /api/reserva-completada — CON VERIFICACIÓN DE 24HS INTEGRADA
// --------------------------------------------------------------------------
app.post('/api/reserva-completada', async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) return res.status(400).json({ success: false, error: 'Falta bookingId' });

    const bookingRef  = db.collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) return res.status(404).json({ success: false, error: 'Reserva no encontrada' });

    const realBooking = bookingSnap.data();

    if (!(await perteneceACapelli({ booking: realBooking }))) {
      return reenviarABarberGo('/api/reserva-completada', req.body, res);
    }

    if (!realBooking.isPrimary || realBooking.ratingTemplateSent) {
      return res.status(200).json({ success: true, message: 'Ya procesado o no es primario' });
    }

    const empresarial = await esEmpresarial(realBooking);
    if (!empresarial) {
      await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'Plan sin calificaciones automáticas' });
    }

    // ✅ SOLO enviar si la reserva fue HOY o AYER (menos de 24hs)
    // Si es más vieja, Meta abre nueva ventana de conversación y cobra
    // (fechaPY con offset fijo UTC-3 — ver comentario arriba, antes usaba
    // toLocaleDateString('America/Asuncion') que daba la hora atrasada)
    const fechaReserva = realBooking.date;
    const hoyAsuncion  = fechaPY();
    const ayerAsuncion = fechaPY(-1);

    if (fechaReserva !== hoyAsuncion && fechaReserva !== ayerAsuncion) {
      console.log(`⏭️ [Capelli] Reserva del ${fechaReserva} fuera de ventana 24hs — calificación omitida`);
      await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'Reserva fuera de ventana de 24hs — calificación omitida' });
    }

    console.log(`💈 [Capelli] Cuenta EMPRESARIAL. Solicitando calificación con: ${TEMPLATES.calificacion}`);
    await enviarCalificacionWhatsApp(realBooking);
    await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });

    return res.status(200).json({ success: true, message: 'Solicitud de calificación enviada', sentBy: 'capelli' });
  } catch (error) {
    console.error('❌ Error en /api/reserva-completada:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

app.post('/api/admin-notificar-cancelacion', async (req, res) => {
  try {
    const { reserva } = req.body;
    if (!reserva || !reserva.client || !reserva.client.phone)
      return res.status(400).json({ success: false, error: 'Faltan datos' });

    if (!(await perteneceACapelli({ booking: reserva })))
      return reenviarABarberGo('/api/admin-notificar-cancelacion', req.body, res);

    const numeroMeta = normalizarNumeroPY(reserva.client.phone);
    await enviarRespuestaWhatsApp(reserva, 'cancelled', numeroMeta);
    return res.status(200).json({ success: true, message: 'Cancelación enviada', sentBy: 'capelli' });
  } catch (error) {
    console.error('❌ Error en /api/admin-notificar-cancelacion:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ========================================
// WEBHOOK META
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

          console.log(`📞 [Capelli] Mensaje de: ${numeroMeta} | Texto: "${respuestaCliente}"`);

          // 1. Calificación 1-5
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
            const session   = sessionSnap.data();
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
                for (const idValue of [Number(barberId), barberId]) {
                  const q = await db.collection('locations').doc(locationId).collection('barbers').where('id', '==', idValue).limit(1).get();
                  if (!q.empty) { barberRef = q.docs[0].ref; break; }
                }
              }
              if (!barberRef) { await bookingDoc.ref.update({ isReviewed: true }); continue; }

              await db.runTransaction(async (t) => {
                const barberDoc = await t.get(barberRef);
                if (!barberDoc.exists) return;
                const curr  = barberDoc.data().rating || 0;
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
          const palabras    = respuestaCliente.split(/[\s,.!?;:()]+/).filter(Boolean);
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
          await enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta, false);
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
    const py = horaParaguay();
    const todayStr = py.dateStr;

    const snapshot = await db.collection('bookings')
      .where('date', '==', todayStr)
      .where('locationId', 'in', LOCATION_IDS)
      .where('status', '==', 'confirmed')
      .where('reminderSent', '==', false).get();

    for (const doc of snapshot.docs) {
      // try/catch por reserva: una falla no debe abortar el resto de la corrida
      try {
        const reserva = doc.data();
        const timeStr = reserva.startTime || reserva.time;
        if (!timeStr) continue;

        const diffMinutes = minutosHastaTurno(timeStr, py);
        if (diffMinutes !== null && diffMinutes >= 105 && diffMinutes <= 135) {
          await db.collection('bookings').doc(doc.id).update({ reminderSent: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          await enviarRecordatorioWhatsApp(reserva);
        }
      } catch (eDoc) {
        console.error(`❌ [Capelli CRON] Error procesando reserva ${doc.id}:`, eDoc.message);
      }
    }
  } catch (error) {
    console.error('❌ [Capelli CRON] Error:', error);
  }
});

// ========================================
// NOTIFICACIONES PUSH FCM
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
  console.log(`🚀 Capelli WhatsApp API activa en puerto ${PORT}`);
  console.log(`🚦 Relay configurado hacia BarberGo: ${BARBERGO_SERVER_URL}`);
  console.log(`💳 Cupo mensual WhatsApp: ${WHATSAPP_MENSUAL_LIMIT} msgs/mes`);
  console.log(`📡 Alcance compartido con el bot de BarberGo vía meta_reach_daily (mismo Business Portfolio)`);
});