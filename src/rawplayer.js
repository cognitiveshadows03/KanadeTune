// rawplayer.js — direct InnerTube /player calls with Metrolist-grade client
// payloads (full device context). youtubei.js's built-in client definitions
// are sparser and get flagged; these mirror what working Android clients
// (Metrolist/ArchiveTune family) send. Used ONLY for stream resolution —
// browse/search/lyrics stay on youtubei.js.
import { tauriFetch as tfetch } from './tfetch.js';
import { dlog } from './debuglog.js';

const PLAYER_URL = 'https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false';

// Client payloads adapted from Metrolist's YouTubeClient.kt (MIT-family OSS).
export const RAW_CLIENTS = [
  {
    label: 'ANDROID_VR_1_61',
    ua: 'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1; Cronet/132.0.6808.3)',
    context: {
      clientName: 'ANDROID_VR', clientVersion: '1.61.48',
      osName: 'Android', osVersion: '12',
      deviceMake: 'Oculus', deviceModel: 'Quest 3',
      androidSdkVersion: '32'
    },
    includeUaInContext: true
  },
  {
    label: 'ANDROID_VR_1_65',
    ua: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    context: {
      clientName: 'ANDROID_VR', clientVersion: '1.65.10',
      osName: 'Android', osVersion: '12L',
      deviceMake: 'Oculus', deviceModel: 'Quest 3',
      androidSdkVersion: '32'
    },
    includeUaInContext: true
  },
  {
    label: 'VISIONOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    context: {
      clientName: 'VISIONOS', clientVersion: '0.1',
      osName: 'visionOS', osVersion: '1.3.21O771',
      deviceMake: 'Apple', deviceModel: 'RealityDevice14,1'
    },
    includeUaInContext: false
  },
  {
    label: 'IPADOS',
    ua: 'com.google.ios.youtube/21.03.3 (iPad7,6; U; CPU iPadOS 17_7_10 like Mac OS X; en-US)',
    context: {
      clientName: 'IOS', clientVersion: '21.03.3',
      osName: 'iPadOS', osVersion: '17.7.10.21H450',
      deviceMake: 'Apple', deviceModel: 'iPad7,6'
    },
    includeUaInContext: false
  },
  {
    label: 'IOS',
    ua: 'com.google.ios.youtube/21.03.1 (iPhone16,2; U; CPU iOS 18_2 like Mac OS X;)',
    context: {
      clientName: 'IOS', clientVersion: '21.03.1',
      osVersion: '18.2.22C152'
    },
    includeUaInContext: false
  }
];

async function callPlayer(videoId, rc, { gl, hl, visitorData }) {
  const client = {
    clientName: rc.context.clientName,
    clientVersion: rc.context.clientVersion,
    gl: gl || 'US',
    hl: hl || 'en',
    ...(visitorData ? { visitorData } : {}),
    ...(rc.context.osName ? { osName: rc.context.osName } : {}),
    ...(rc.context.osVersion ? { osVersion: rc.context.osVersion } : {}),
    ...(rc.context.deviceMake ? { deviceMake: rc.context.deviceMake } : {}),
    ...(rc.context.deviceModel ? { deviceModel: rc.context.deviceModel } : {}),
    ...(rc.context.androidSdkVersion ? { androidSdkVersion: rc.context.androidSdkVersion } : {}),
    ...(rc.includeUaInContext ? { userAgent: rc.ua } : {})
  };
  const body = {
    context: { client },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true
  };
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': rc.ua,
    'X-Goog-Api-Format-Version': '2'
  };
  if ((rc.context.clientName || '').startsWith('ANDROID')) {
    headers['X-Youtube-Client-Name'] = '28';
    headers['X-Youtube-Client-Version'] = rc.context.clientVersion;
  }
  const res = await tfetch(PLAYER_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`player HTTP ${res.status}`);
  return res.json();
}

function bestAudio(streamingData, sup) {
  const fmts = (streamingData?.adaptiveFormats || [])
    .filter(f => (f.mimeType || '').startsWith('audio/'))
    .filter(f => /opus|mp4a/i.test(f.mimeType || ''))
    .filter(f => f.url); // raw path: only direct URLs (no cipher solving here)
  fmts.sort((a, b) => {
    const ao = /opus/i.test(a.mimeType) ? 1 : 0;
    const bo = /opus/i.test(b.mimeType) ? 1 : 0;
    if (sup.opus && ao !== bo) return bo - ao;  // opus first when playable
    return (b.bitrate || 0) - (a.bitrate || 0);
  });
  return fmts[0] || null;
}

// Resolve a playable stream via raw clients. Returns null if all fail
// (caller falls back to the youtubei.js path).
export async function rawStream(videoId, sup, locale) {
  for (const rc of RAW_CLIENTS) {
    try {
      const data = await callPlayer(videoId, rc, locale || {});
      const status = data?.playabilityStatus?.status;
      const n = (data?.streamingData?.adaptiveFormats || []).filter(f => (f.mimeType || '').startsWith('audio/')).length;
      dlog('raw:', rc.label, status, '| audio formats:', n);
      if (status !== 'OK') continue;
      const fmt = bestAudio(data.streamingData, sup);
      if (!fmt) continue;
      const isAac = /mp4a/i.test(fmt.mimeType || '');
      dlog('raw: SELECTED', rc.label, fmt.mimeType, Math.round((fmt.bitrate || 0) / 1000) + 'kbps');
      return {
        url: fmt.url,
        ua: rc.ua,
        mime: fmt.mimeType || '',
        bitrate: fmt.bitrate || 0,
        durationSec: Number(data?.videoDetails?.lengthSeconds) || null,
        client: rc.label,
        codecs: sup,
        needsTranscode: isAac && !sup.aac
      };
    } catch (e) {
      dlog('raw:', rc.label, 'threw:', String(e?.message || e).slice(0, 80));
    }
  }
  return null;
}
