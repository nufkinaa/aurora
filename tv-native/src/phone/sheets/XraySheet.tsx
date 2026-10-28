// X-Ray on the phone: who is in it, the facts and the ratings — the same
// /api/xray answer the TV's XraySheet and the website's X-Ray panel draw.
import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Image, StyleSheet, Text, View} from 'react-native';
import {api, imgSrc, XrayData, XrayPerson, XrayQuery} from '../../api';
import Sheet from '../ui/Sheet';
import {colors, GUTTER} from '../theme';

const list = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v.join(', ') : v || '');

const Person = ({p}: {p: XrayPerson}) => {
  const pic = p.photo ? imgSrc(p.photo) : null;
  return (
    <View style={s.person}>
      <View style={s.face}>{pic ? <Image source={pic} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <Text style={s.initial}>{(p.name || '?').slice(0, 1)}</Text>}</View>
      <View style={{flex: 1}}>
        <Text style={s.name} numberOfLines={1}>
          {p.name}
        </Text>
        {p.role || p.job ? (
          <Text style={s.role} numberOfLines={1}>
            {p.role || p.job}
          </Text>
        ) : null}
      </View>
    </View>
  );
};

export default function XraySheet({query, title, onClose}: {query: XrayQuery; title: string; onClose: () => void}) {
  const [data, setData] = useState<XrayData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api
      .xray(query)
      .then(d => live && setData(d))
      .catch(e => live && setError(String(e?.message || "Couldn't load X-Ray")));
    return () => {
      live = false;
    };
  }, [query]);
  const ep = data?.episode;
  const facts = (data?.facts || []).slice(0, 6);
  const ratings = (data?.ratings || []).map(r => `${r.source} ${r.value}${r.scale ? `/${r.scale}` : ''}`).join('   ');
  return (
    <Sheet visible onClose={onClose} title={`X-Ray · ${data?.title || title}`} sub={ratings || undefined}>
      {!data && !error ? <ActivityIndicator color={colors.text} style={{margin: 24}} /> : null}
      {error || data?.error ? <Text style={s.empty}>{error || data?.error}</Text> : null}
      {ep ? (
        <View style={s.block}>
          <Text style={s.h}>{`S${ep.season} E${ep.episode} · ${ep.title}`}</Text>
          {ep.overview ? <Text style={s.body}>{ep.overview}</Text> : null}
          {ep.directors ? <Text style={s.fact}>Directed by {list(ep.directors)}</Text> : null}
          {ep.writers ? <Text style={s.fact}>Written by {list(ep.writers)}</Text> : null}
        </View>
      ) : null}
      {facts.length ? (
        <View style={s.block}>
          {facts.map(f => (
            <Text key={f.label} style={s.fact}>
              <Text style={{color: colors.textDim}}>{f.label} </Text>
              {f.value}
            </Text>
          ))}
        </View>
      ) : null}
      {(ep?.guests || []).length ? <Text style={s.section}>Guest stars</Text> : null}
      {(ep?.guests || []).slice(0, 12).map((p, i) => (
        <Person key={`g${i}`} p={p} />
      ))}
      {(data?.cast || []).length ? <Text style={s.section}>Cast</Text> : null}
      {(data?.cast || []).slice(0, 30).map((p, i) => (
        <Person key={`c${i}`} p={p} />
      ))}
      {(data?.crew || []).length ? <Text style={s.section}>Crew</Text> : null}
      {(data?.crew || []).slice(0, 12).map((p, i) => (
        <Person key={`w${i}`} p={p} />
      ))}
    </Sheet>
  );
}

const s = StyleSheet.create({
  empty: {color: colors.textDim, fontSize: 15, padding: GUTTER + 4},
  block: {paddingHorizontal: GUTTER + 4, paddingBottom: 8, gap: 4},
  h: {color: colors.text, fontSize: 16, fontWeight: '800'},
  body: {color: colors.textDim, fontSize: 15, lineHeight: 21},
  fact: {color: colors.text, fontSize: 14, lineHeight: 20},
  section: {color: colors.textDim, fontSize: 13, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: GUTTER + 4, marginTop: 12, marginBottom: 4},
  person: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: GUTTER + 4, paddingVertical: 6},
  face: {width: 46, height: 46, borderRadius: 23, backgroundColor: 'rgba(255,255,255,0.1)', overflow: 'hidden', alignItems: 'center', justifyContent: 'center'},
  initial: {color: colors.text, fontSize: 18, fontWeight: '800'},
  name: {color: colors.text, fontSize: 15, fontWeight: '700'},
  role: {color: colors.textDim, fontSize: 13},
});
