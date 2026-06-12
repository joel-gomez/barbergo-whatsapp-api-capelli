// server_capelli.js — SERVIDOR EXCLUSIVO DE CAPELLI

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

const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const PORT            = process.env.PORT || 10000;
const COMPANY_ID      = 'nI6ilcu8qPbH3xiXXsM7';
const LOCATION_ID = '2OaikKXImqJbfPaqXfG6';
// ========================================
// PLANTILLAS DE CAPELLI
// ========================================
const TEMPLATES = {
  solicitud:    'solicitud_reserva_capelli_v1',
  confirmada:   'reserva_confirmada_capelli_v1',
  cancelada:    'reserva_cancelada_capelli_v1',
  recordatorio: 'recordatorio_turno_capelli_v1',
  calificacion: 'calificar_barbero_capelli_v1',
  agradecimiento: 'agradecimiento_capelli_v1'
};

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

async function obtenerDatosUbicacion(locationId) {
  const defaults = { shopName: 'Capelli', mapLink: 'https://maps.app.goo.gl/tu-local', shopUrl: 'https://app.barbergo.com.py' };
  if (!locationId) return defaults;
  try {
    const snap = await db.collection('locations').doc(locationId).get();
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

// ELIMINAR todo este bloque del interceptor viejo:
if (templateName === 'solicitud_reserva_v3') {
  templateName = 'solicitud_reserva_v3_';
}
if (templateName === 'calificar_barbero_v2') {
  templateName = 'calificar_barbero'; 
}
if (templateName === 'reserva_confirmada_v2') {
  templateName = 'TU_NOMBRE_DE_PLANTILLA_CONFIRMADA_CAPELLI'; 
}
if (templateName === 'reserva_cancelada_v3') {
  templateName = 'TU_NOMBRE_DE_PLANTILLA_CANCELADA_CAPELLI'; 
}
if (templateName === 'recordatorio_turno_v4') {
  templateName = 'TU_NOMBRE_DE_PLANTILLA_RECORDATORIO_CAPELLI'; 
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
app.get('/', (req, res) => res.status(200).json({ ok: true, message: 'Capelli WhatsApp API activa' }));

app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [] } = req.body;

    if (!phone || !templateName) {
      return res.status(400).json({ success: false, error: 'phone y templateName son obligatorios' });
    }

    const TEMPLATE_MAP = {
      'solicitud_reserva_v3':    'solicitud_reserva_capelli_v1',
      'solicitud_reserva_v3_':   'solicitud_reserva_capelli_v1',
      'reserva_confirmada_v2':   'reserva_confirmada_capelli_v1',
      'reserva_cancelada_v3':    'reserva_cancelada_capelli_v1',
      'recordatorio_turno_v3':   'recordatorio_turno_capelli_v1',
      'recordatorio_turno_v4':   'recordatorio_turno_capelli_v1',
      'calificar_barbero_v2':    'calificar_barbero_capelli_v1',
      'calificar_barbero':       'calificar_barbero_capelli_v1',
      'agradecimiento_v1':       'agradecimiento_capelli_v1'
    };

    const resolvedTemplate = TEMPLATE_MAP[templateName] || templateName;
    console.log(`[Capelli] Traducción: '${templateName}' → '${resolvedTemplate}'`);

    const cleanPhone = normalizarNumeroPY(phone);
    const ok = await enviarTemplate(cleanPhone, resolvedTemplate, params);

    return res.status(ok ? 200 : 500).json({ success: ok, templateUsed: resolvedTemplate });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// REEMPLAZAR la ruta completa /api/reserva-completada:

app.post('/api/reserva-completada', async (req, res) => {
  console.log(`🔔 [Capelli] /api/reserva-completada recibido | body:`, JSON.stringify(req.body));
  try {
    // Acepta tanto { bookingId } directo como { reserva, bookingId } delegado desde BarberGo
    let { reserva, bookingId } = req.body;

    // Si no viene reserva en el body, la buscamos por bookingId en Firestore
    if (!reserva && bookingId) {
      const snap = await db.collection('bookings').doc(bookingId).get();
      if (!snap.exists) return res.status(404).json({ success: false, error: 'Reserva no encontrada' });
      reserva = snap.data();
    }

    if (!reserva || !bookingId) {
      return res.status(400).json({ success: false, error: 'Faltan datos' });
    }

    // Validaciones de negocio
    if (!reserva.isPrimary)          return res.status(200).json({ success: true, message: 'No es reserva primaria' });
    if (reserva.ratingTemplateSent)  return res.status(200).json({ success: true, message: 'Rating ya enviado' });

    // Verificar plan premium
    const bookingRef = db.collection('bookings').doc(bookingId);
    let premium = false;
    try {
      const snap = await db.collection('companies').doc(COMPANY_ID).get();
      if (snap.exists) premium = snap.data().plan?.toLowerCase() === 'premium';
    } catch (e) {
      console.error('[Capelli] Error verificando plan:', e);
    }

    if (!premium) {
      await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'No es Premium' });
    }

    console.log(`💈 [Capelli] Enviando solicitud de calificación para booking ${bookingId}`);
    await enviarCalificacionWhatsApp(reserva);
    await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });

    return res.status(200).json({ success: true, message: 'Calificación enviada' });

  } catch (error) {
    console.error('❌ [Capelli] Error en /api/reserva-completada:', error);
    return res.status(500).json({ success: false, error: error.message });
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

          console.log(`📞 [Capelli] De: ${numeroMeta} | Texto: "${respuestaCliente}"`);

          // Calificación 1-5
          const ratingMatch = respuestaCliente.trim().match(/^[1-5]$/);
          if (ratingMatch) {
            const stars = parseInt(ratingMatch[0]);
            await db.collection('rating_sessions').doc(telefonoLocal).set({
              stars, phone: telefonoLocal, companyId: COMPANY_ID,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              expiresAt: new Date(Date.now() + 10 * 60 * 1000)
            });
            continue;
          }

          // Comentario de calificación
          const sessionSnap = await db.collection('rating_sessions').doc(telefonoLocal).get();
          if (sessionSnap.exists) {
            const session = sessionSnap.data();
            const expiresAt = session.expiresAt?.toDate ? session.expiresAt.toDate() : new Date(session.expiresAt);
            if (new Date() < expiresAt) {
              const { stars } = session;
              const comment = respuestaCliente.trim();
              await db.collection('rating_sessions').doc(telefonoLocal).delete();

const snapshot = await db.collection('bookings')
  .where('client.phone', '==', telefonoLocal)
  .where('locationId', '==', LOCATION_ID)   // 🆕
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
              if (directSnap.exists) barberRef = directSnap.ref;
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
            await db.collection('rating_sessions').doc(telefonoLocal).delete();
          }

          // Confirmación / Cancelación
          const palabras = respuestaCliente.split(/[\s,.!?;:()]+/).filter(Boolean);
          const esConfirmar = palabras.some(p => ['si','sí','sii','ok','okey','dale','voy','perfecto','excelente','seguro'].includes(p)) || respuestaCliente.includes('confirm');
          const esCancelar  = palabras.some(p => ['no','imposible'].includes(p)) || respuestaCliente.includes('cancel') || respuestaCliente.includes('no voy') || respuestaCliente.includes('me complico');

          let nuevoEstado = null;
          if (esCancelar)       nuevoEstado = 'cancelled';
          else if (esConfirmar) nuevoEstado = 'confirmed';
          if (!nuevoEstado) continue;

          const estadosValidos = nuevoEstado === 'confirmed' ? ['pending'] : ['pending', 'confirmed'];
const snap = await db.collection('bookings')
  .where('client.phone', '==', telefonoLocal)
  .where('locationId', '==', LOCATION_ID)   // 🆕
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
  .where('locationId', '==', LOCATION_ID)   // 🆕
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

app.listen(PORT, () => console.log(`🚀 Capelli WhatsApp API activa en puerto ${PORT}`));