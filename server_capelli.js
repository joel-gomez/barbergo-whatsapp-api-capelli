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

function minutosHastaTurno(startTimeStr, pyNow) {
  if (!startTimeStr) return null;
  const [h, m] = startTimeStr.split(':').map(Number);
  return (h * 60 + m) - pyNow.minutosDelDia;
}

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
// 📅 CICLO DE FACTURACIÓN DE CAPELLI — mismo mecanismo que server.js
// compartido: en vez de reiniciar el cupo el día 1 de cada mes
// calendario, se ancla a companies/{COMPANY_ID}.paidUntil (la fecha de
// vencimiento que se actualiza a mano en el SuperAdmin cada vez que
// Capelli paga). Mientras paidUntil no cambie, sigue siendo el mismo
// ciclo; el día que se actualiza, arranca uno nuevo solo.
// Se cachea 60s para no pegarle a Firestore en cada mensaje.
// =====================================================================
let PAID_UNTIL_CACHE = { value: undefined, cachedAt: 0 };
const PAID_UNTIL_TTL_MS = 60 * 1000;

async function obtenerPaidUntil() {
  const ahora = Date.now();
  if (PAID_UNTIL_CACHE.value !== undefined && (ahora - PAID_UNTIL_CACHE.cachedAt) < PAID_UNTIL_TTL_MS) {
    return PAID_UNTIL_CACHE.value;
  }
  try {
    const snap = await db.collection('companies').doc(COMPANY_ID).get();
    const paidUntil = snap.exists ? (snap.data().paidUntil || null) : null;
    PAID_UNTIL_CACHE = { value: paidUntil, cachedAt: ahora };
    return paidUntil;
  } catch (e) {
    console.error('⚠️ [Capelli] Error obteniendo paidUntil:', e.message);
    return null;
  }
}

function obtenerCicloId(paidUntil) {
  if (paidUntil) {
    try {
      const fecha = paidUntil.toDate ? paidUntil.toDate() : new Date(paidUntil);
      if (!isNaN(fecha.getTime())) {
        return `venc-${fecha.toISOString().slice(0, 10)}`;
      }
    } catch (e) { /* cae al respaldo de abajo */ }
  }
  return fechaPY().slice(0, 7);
}

// =====================================================================
// 💳 CUPO MENSUAL DE MENSAJES DE CAPELLI
// =====================================================================
const WHATSAPP_MENSUAL_LIMIT = parseInt(process.env.WHATSAPP_MENSUAL_LIMIT || '2000', 10);
const BLOQUEO_ACTIVO = false;

async function puedeEnviar(companyId = COMPANY_ID) {
  const paidUntil = await obtenerPaidUntil();
  const cicloId = obtenerCicloId(paidUntil);
  try {
    const snap = await db.collection('usage_monthly').doc(`monthly_${companyId}_${cicloId}`).get();
    const actual = snap.exists ? (snap.data().count || 0) : 0;
    if (actual >= WHATSAPP_MENSUAL_LIMIT) return { permitido: !BLOQUEO_ACTIVO, motivo: 'limite_mensual_capelli' };
    return { permitido: true, motivo: 'capelli_ok', count: actual, limit: WHATSAPP_MENSUAL_LIMIT };
  } catch (e) {
    console.error('❌ [Capelli] Error en puedeEnviar:', e.message);
    return { permitido: true, motivo: 'error_check' };
  }
}

// categoria: para qué se usó el mensaje — mismo desglose que server.js
// 🆓 Categorías que caen dentro de una ventana de servicio ya abierta
// por el cliente — no generan cobro nuevo de Meta en la práctica. Se
// registran en el desglose, pero NO suman al "count" que compite
// contra el límite mensual.
const CATEGORIAS_GRATIS = ['respuestaCliente', 'agradecimiento'];

async function consumirCupo(companyId = COMPANY_ID, categoria = 'otro') {
  const paidUntil = await obtenerPaidUntil();
  const cicloId = obtenerCicloId(paidUntil);
  const ref = db.collection('usage_monthly').doc(`monthly_${companyId}_${cicloId}`);
  const esGratis = CATEGORIAS_GRATIS.includes(categoria);
  try {
    const r = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const actual = snap.exists ? (snap.data().count || 0) : 0;
      const desgloseActual = snap.exists ? (snap.data().desglose || {}) : {};
      const nuevoDesglose = { ...desgloseActual, [categoria]: (desgloseActual[categoria] || 0) + 1 };
      const nuevoCount = esGratis ? actual : actual + 1;
      t.set(ref, {
        companyId,
        plan: 'empresarial',
        mes: fechaPY().slice(0, 7),
        cicloId,
        count: nuevoCount,
        limit: WHATSAPP_MENSUAL_LIMIT,
        desglose: nuevoDesglose,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { consumido: true, count: nuevoCount };
    });
    console.log(`📊 [Capelli] usa ${r.count}/${WHATSAPP_MENSUAL_LIMIT} msgs en su ciclo actual (${cicloId}). (${categoria}${esGratis ? ' — gratis, no sumó' : ''})`);
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
// 📤 ENVIAR TEMPLATE (con categoria para el desglose)
// =====================================================================
async function enviarTemplate(numero, templateName, params = [], companyId = COMPANY_ID, skipLimitCheck = false, esIniciadoPorNegocio = true, categoria = 'otro') {
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
      return false;
    }
    console.log(`✅ [Capelli] Template '${templateName}' enviado a ${numero}`);
    await consumirCupo(companyId, categoria);
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
  const categoria = !esIniciadoPorNegocio
    ? 'respuestaCliente'
    : (nuevoEstado === 'confirmed' ? 'confirmadaDirecta' : 'cancelada');
  await enviarTemplate(numeroMeta, templateName, [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, linkFinal], COMPANY_ID, false, esIniciadoPorNegocio, categoria);
}

async function enviarRecordatorioWhatsApp(reserva) {
  const { shopName, mapLink } = await obtenerDatosUbicacion(reserva.locationId);
  const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);
  const cleanPhone = normalizarNumeroPY(reserva.client?.phone);
  await enviarTemplate(cleanPhone, TEMPLATES.recordatorio, [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, mapLink], COMPANY_ID, false, true, 'recordatorio');
}

async function enviarCalificacionWhatsApp(reserva) {
  const cleanPhone = normalizarNumeroPY(reserva.client?.phone);
  if (!cleanPhone) return;
  const { shopName } = await obtenerDatosUbicacion(reserva.locationId);
  await enviarTemplate(cleanPhone, TEMPLATES.calificacion, [reserva.client?.name || 'Cliente', shopName, reserva.barber?.name || 'tu barbero'], COMPANY_ID, false, true, 'calificacion');
}

async function enviarAgradecimientoWhatsApp(reserva, telefonoLocal) {
  try {
    const snap = await db.collection('companies').doc(COMPANY_ID).get();
    if (!snap.exists) return;
    const plan = snap.data().plan?.toLowerCase() || '';
    if (plan !== 'empresarial' && plan !== 'premium') return;
  } catch (e) { return; }
  await enviarTemplate(normalizarNumeroPY(telefonoLocal), TEMPLATES.agradecimiento, [], COMPANY_ID, false, false, 'agradecimiento');
}

// ========================================
// RUTAS
// ========================================
app.get('/', (req, res) => res.status(200).json({ ok: true, message: 'Capelli WhatsApp API activa', role: 'capelli' }));

app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [], locationId, companyId, esReenvioManual } = req.body;
    if (!phone || !templateName) return res.status(400).json({ success: false, error: 'phone y templateName son obligatorios' });

    if ((companyId || locationId) && !(await perteneceACapelli({ companyId, locationId }))) {
      return reenviarABarberGo('/api/enviar-mensaje', req.body, res);
    }

    const cid = companyId || COMPANY_ID;

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

    let categoria = 'otro';
    if (esReenvioManual) categoria = 'reenvioManual';
    else if (resolvedTemplate === TEMPLATES.solicitud) categoria = 'solicitud';
    else if (resolvedTemplate === TEMPLATES.confirmada) categoria = 'confirmadaDirecta';
    else if (resolvedTemplate === TEMPLATES.cancelada) categoria = 'cancelada';

    const ok = await enviarTemplate(cleanPhone, resolvedTemplate, params, cid, true, true, categoria);
    return res.status(ok ? 200 : 500).json({ success: ok, templateUsed: resolvedTemplate, sentBy: 'capelli' });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

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