'use strict';

const liveProfile = {
    clientVersion: process.env.DISCORD_CLIENT_VERSION || '1.0.9267',
    chromeVersion: process.env.DISCORD_CHROME_VERSION || '138.0.7204.251',
    electronVersion: process.env.DISCORD_ELECTRON_VERSION || '37.6.0',
    buildNumber: Number(process.env.DISCORD_BUILD_NUMBER) || 572700,
    nativeBuildNumber: Number(process.env.DISCORD_NATIVE_BUILD_NUMBER) || 47491,
    locale: process.env.DISCORD_LOCALE || 'th-TH',
    timezone: process.env.DISCORD_TIMEZONE || 'Asia/Bangkok'
};

function getUserAgent() {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/${liveProfile.clientVersion} Chrome/${liveProfile.chromeVersion} Electron/${liveProfile.electronVersion} Safari/537.36`;
}

function buildSuperProperties() {
    const ua = getUserAgent();
    return Buffer.from(JSON.stringify({
        os: 'Windows',
        browser: 'Discord Client',
        release_channel: 'stable',
        client_version: liveProfile.clientVersion,
        os_version: '10.0.22631',
        app_arch: 'x64',
        system_locale: liveProfile.locale,
        browser_user_agent: ua,
        browser_version: liveProfile.chromeVersion,
        client_build_number: liveProfile.buildNumber,
        native_build_number: liveProfile.nativeBuildNumber,
        client_event_source: null,
        design_id: 0
    })).toString('base64');
}

function buildUserHeaders(token, path = '') {
    const ua = getUserAgent();
    const chromeMajor = liveProfile.chromeVersion.split('.')[0];
    return {
        Authorization: token,
        'Content-Type': 'application/json',
        'User-Agent': ua,
        'X-Super-Properties': buildSuperProperties(),
        'X-Debug-Options': 'bugReporterEnabled',
        'X-Discord-Locale': liveProfile.locale,
        'X-Discord-Timezone': liveProfile.timezone,
        Accept: '*/*',
        'Accept-Language': `${liveProfile.locale},en-US;q=0.9,en;q=0.8`,
        Referer: path.startsWith('/quests/')
            ? 'https://discord.com/quest-home'
            : 'https://discord.com/channels/@me',
        Origin: 'https://discord.com',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'sec-ch-ua': `"Chromium";v="${chromeMajor}", "Not)A;Brand";v="8"`,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
    };
}

module.exports = {
    liveProfile,
    getUserAgent,
    buildSuperProperties,
    buildUserHeaders
};
