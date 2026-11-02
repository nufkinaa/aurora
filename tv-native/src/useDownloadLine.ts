// "3 downloading · 12 ready" for a Settings row (TV and phone): this profile's own
// downloads, read when the page is up and kept current over the socket. It only
// counts; there is no limit on how many a person may have.
import {useCallback, useEffect, useRef, useState} from 'react';
import {api, MyDownload} from './api';
import {countLine, downloadCounts} from './downloadsLogic';
import {onMessage} from './realtime';

export const useDownloadLine = (profileId: string, live: boolean): string => {
  const [line, setLine] = useState('');
  const jobs = useRef(new Map<string, MyDownload>());
  const say = useCallback(() => setLine(countLine(downloadCounts([...jobs.current.values()]))), []);
  const load = useCallback(() => {
    if (!profileId) return;
    api
      .myDownloads(profileId)
      .then(list => {
        jobs.current = new Map(list.filter(j => j.mine).map(j => [j.id, j]));
        say();
      })
      .catch(() => {});
  }, [profileId, say]);
  useEffect(() => {
    if (!live) return;
    load();
    const a = onMessage('download_update', d => {
      const job = d.job as MyDownload | undefined;
      if (!job || !job.mine) return;
      jobs.current.set(job.id, job);
      say();
    });
    const b = onMessage('download_removed', d => {
      if (jobs.current.delete(String(d.id))) say();
    });
    const c = onMessage('welcome', load);
    return () => {
      a();
      b();
      c();
    };
  }, [live, load, say]);
  return line;
};
