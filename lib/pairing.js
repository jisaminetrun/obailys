
import pino from 'pino';
import makeWASocket from './Socket/index.js';
import { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } from './Utils/index.js';
import { DisconnectReason } from './Types/index.js';

export const normalizePhoneNumber = (input, countryCode = '62') => {
    let digits = String(input ?? '').replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0')) digits = countryCode + digits.slice(1);
    if (digits.length < 8 || digits.length > 15) {
        throw new Error('Invalid phone number. Use the format 08xx or 628xx.');
    }
    return digits;
};

export const connectWithPairing = async (options = {}) => {
    const {
        number,
        sessionDir = 'session',
        countryCode = '62',
        customCode,
        browser = Browsers.ubuntu('Chrome'),
        socketOptions = {},
        maxRestarts = 10,
        onCode, onOpen, onClose, onSocket
    } = options;

    const phone = normalizePhoneNumber(number, countryCode);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use the default version */ }

    let restarts = 0;
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };

        const start = () => {
            const sock = makeWASocket({
                version,
                auth: state,
                logger: pino({ level: 'silent' }),
                browser,
                ...socketOptions
            });
            let asked = false;
            onSocket?.(sock);
            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
                if (qr && !state.creds.registered && !asked) {
                    asked = true;
                    try {
                        const code = await sock.requestPairingCode(phone, customCode);
                        onCode?.(code.match(/.{1,4}/g)?.join('-') ?? code, phone);
                    } catch (err) {
                        done(reject, err);
                    }
                }
                if (connection === 'open') {
                    restarts = 0;
                    onOpen?.(sock);
                    done(resolve, sock);
                }
                if (connection === 'close') {
                    const status = lastDisconnect?.error?.output?.statusCode;
                    onClose?.(status, lastDisconnect?.error);
                    if (status === DisconnectReason.loggedOut) {
                        return done(reject, new Error('Logged out. Delete the session folder and try again.'));
                    }
                    if (++restarts > maxRestarts) {
                        return done(reject, new Error('Too many reconnection attempts.'));
                    }
                    setTimeout(start, Math.min(1000 * restarts, 5000));
                }
            });
        };
        start();
    });
};
