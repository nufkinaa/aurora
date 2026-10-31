// [auth-round] Google on the TV: the device-code flow (POST /api/auth/google/
// start {intent} + /poll), for signing in, requesting access and resetting a
// password. The TV shows Google's address and a short code, and a QR that
// opens the address with the code filled in; the person says yes on their
// phone or computer, and this step hands Google's answer up (authFlow.ts
// googleNext says what it means).
import React, {useEffect, useRef, useState} from 'react';
import {Text, View} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import {api, ApiError, GoogleOutcome} from '../api';
import {GoogleNext, googleNext, refusalWords} from '../authFlow';
import {A, as, Body, CodeBlock, FormError, PlainButton, Row, Title, Waiting} from './authKit';

export default function GoogleDevice({
  intent,
  title,
  line,
  onOutcome,
  onBack,
}: {
  intent: 'signin' | 'signup' | 'reset';
  title: string;
  line?: string;
  // a finished answer (never 'wait'); `raw` is the server's own, for a sign-in
  onOutcome: (next: GoogleNext, raw: GoogleOutcome) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState<{userCode: string; url: string} | null>(null);
  const [err, setErr] = useState('');
  const [round, setRound] = useState(0); // "Try again" starts a fresh code
  const handed = useRef(false);
  const outcome = useRef(onOutcome);
  outcome.current = onOutcome;

  useEffect(() => {
    let live = true;
    let poll: ReturnType<typeof setTimeout> | null = null;
    handed.current = false;
    setCode(null);
    setErr('');
    (async () => {
      let r: Awaited<ReturnType<typeof api.googleStartFor>>;
      try {
        r = await api.googleStartFor(intent);
      } catch (e) {
        if (!live) return;
        setErr(refusalWords(e instanceof ApiError ? e : null, 'google').words);
        return;
      }
      if (!live) return;
      setCode({userCode: r.userCode, url: r.verificationUrl});
      const every = Math.max(3000, (r.interval || 0) * 1000);
      const tick = async () => {
        if (!live || handed.current) return;
        try {
          const p = await api.googlePollFor(r.pollId);
          if (!live || handed.current) return;
          const next = googleNext(p, r.pollId, intent);
          if (next.next === 'wait') {
            poll = setTimeout(tick, every);
            return;
          }
          if (next.next === 'error') {
            setErr(next.words);
            setCode(null);
            return;
          }
          handed.current = true;
          outcome.current(next, p);
        } catch (e) {
          if (!live) return;
          // no answer: keep asking; a refusal (expired, denied): say so
          if (e instanceof ApiError && e.status !== 0) {
            setErr(refusalWords(e, 'google').words);
            setCode(null);
            return;
          }
          poll = setTimeout(tick, every);
        }
      };
      poll = setTimeout(tick, every);
    })();
    return () => {
      live = false;
      if (poll) clearTimeout(poll);
    };
  }, [intent, round]);

  const qrValue = code ? `${code.url}${code.url.includes('?') ? '&' : '?'}user_code=${encodeURIComponent(code.userCode)}` : '';
  return (
    <View>
      <Title line={line}>{title}</Title>
      {err ? (
        <>
          <FormError text={err} />
          <Row>
            <PlainButton uiId="signin.google.retry" label="Try again" first onPress={() => setRound(n => n + 1)} />
            <PlainButton uiId="signin.google.back" label="Back" onPress={onBack} />
          </Row>
        </>
      ) : (
        <View style={as.cols}>
          <View style={as.col}>
            <Body>On your phone or computer, go to</Body>
            <Text style={[as.url, {marginTop: 2, marginBottom: 12}]}>{code ? code.url.replace(/^https?:\/\//, '') : ' '}</Text>
            <CodeBlock label="Then enter this code" code={code ? code.userCode : '· · · ·'} />
            {code ? <Waiting text="Waiting for Google…" /> : <Waiting text="Asking Google for a code…" />}
            <View style={{height: 14}} />
            <Row>
              <PlainButton uiId="signin.google.back" label="Back" first onPress={onBack} />
            </Row>
          </View>
          <View style={{alignItems: 'flex-start', width: 200}}>
            <View style={as.qr}>{code ? <QRCode value={qrValue} size={156} backgroundColor="#ffffff" color="#0b0c14" /> : null}</View>
            <Text style={{color: A.faint, fontSize: 14, lineHeight: 19, marginTop: 8}}>Or scan this with your phone's camera.</Text>
          </View>
        </View>
      )}
    </View>
  );
}
