/**
 * Certificate Manager.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

const config = require('config');
const Constants = require('./constants');
const fetch = require('node-fetch');
const fs = require('fs');
const greenlock = require('greenlock');
const leChallengeDns = require('le-challenge-dns');
const leChallengeFs = require('le-challenge-fs');
const leStoreCertbot = require('le-store-certbot');
const path = require('path');
const Settings = require('./models/settings');
const UserProfile = require('./user-profile');

const DEBUG = false || (process.env.NODE_ENV === 'test');

/**
 * Write certificates generated by registration/renewal to disk.
 *
 * @param {Object} results - Result object from greenlock
 */
function writeCertificates(results) {
  fs.writeFileSync(
    path.join(UserProfile.sslDir, 'certificate.pem'),
    results.cert
  );
  fs.writeFileSync(
    path.join(UserProfile.sslDir, 'privatekey.pem'),
    results.privkey
  );
  fs.writeFileSync(
    path.join(UserProfile.sslDir, 'chain.pem'),
    results.chain
  );
}

/**
 * Register domain with Let's Encrypt and get certificates.
 *
 * @param {string} email - User's email address
 * @param {string?} reclamationToken - Reclamation token, if applicable
 * @param {string} subdomain - The subdomain being registered
 * @param {string} fulldomain - The full domain being registered
 * @param {boolean} optout - Whether or not the user opted out of emails
 * @param {function} callback - Callback function
 */
async function register(email, reclamationToken, subdomain, fulldomain,
                        optout, callback) {
  if (DEBUG) {
    console.debug('Starting registration:', email, reclamationToken, subdomain,
                  fulldomain, optout);
  }

  const endpoint = config.get('ssltunnel.registration_endpoint');
  const leChallenge = leChallengeDns.create({
    debug: DEBUG,
  });
  const leStore = leStoreCertbot.create({
    webrootPath: Constants.BUILD_STATIC_PATH,
    configDir: path.join(UserProfile.baseDir, 'etc'),
    logsDir: path.join(UserProfile.baseDir, 'var', 'log'),
    workDir: path.join(UserProfile.baseDir, 'var', 'lib'),
    debug: DEBUG,
  });
  const le = greenlock.create({
    server: 'https://acme-v02.api.letsencrypt.org/directory',
    challengeType: 'dns-01',
    challenges: {
      'dns-01': leChallenge,
    },
    approveDomains: [
      fulldomain,
    ],
    agreeTos: true,
    communityMember: false,
    securityUpdates: false,
    telemetry: false,
    store: leStore,
    version: 'v02',
    renewWithin: 14 * 24 * 60 * 60 * 1000,  // 2 weeks
    renewBy: 10 * 24 * 60 * 60 * 1000,      // 10 days
    debug: DEBUG,
  });

  let token;
  leChallenge.leDnsResponse =
    (challenge, keyAuthorization, keyAuthDigest) => {
      // Promise to be resolved when LE has the DNS challenge ready for us.
      return new Promise((resolve, reject) => {
        // Now that we have a challenge, we call our registration server to
        // setup the TXT record
        fetch(
          `${endpoint}/dnsconfig?token=${token}&challenge=${keyAuthDigest}`
        ).then((res) => {
          return res.text();
        }).then(() => {
          if (DEBUG) {
            console.debug('Set DNS token on registration server');
          }

          resolve('Success!');
        }).catch((e) => {
          console.error('Failed to set DNS token on registration server:', e);
          callback(e);
          reject(e);
        });
      });
    };

  let jsonToken;
  try {
    let subscribeUrl = `${endpoint}/subscribe?name=${subdomain}&email=${email}`;
    if (reclamationToken) {
      subscribeUrl += `&reclamationToken=${reclamationToken.trim()}`;
    }

    const res = await fetch(subscribeUrl);
    const body = await res.text();

    if (DEBUG) {
      console.debug('Sent subscription to server:', body);
    }

    jsonToken = JSON.parse(body);
    if (jsonToken.error) {
      callback(jsonToken.error);
      return;
    }

    token = jsonToken.token;

    // Store the token in the db
    await Settings.set('tunneltoken', jsonToken);
  } catch (e) {
    console.error('Failed to subscribe:', e);
    callback(e);
    return;
  }

  // Register Let's Encrypt
  try {
    const results = await le.register({
      domains: [
        fulldomain,
      ],
      email: config.get('ssltunnel.certemail'),
      agreeTos: true,
      rsaKeySize: 2048,
      challengeType: 'dns-01',
      debug: DEBUG,
    });

    if (DEBUG) {
      console.debug('Registration success:', results);
    }

    writeCertificates(results);

    // Now we associate user's email with the subdomain, unless it was reclaimed
    if (!reclamationToken) {
      try {
        await fetch(`${endpoint}/setemail?token=${token}&email=${email
        }&optout=${optout}`);

        if (DEBUG) {
          console.debug('Set email on server.');
        }
      } catch (e) {
        console.error('Failed to set email on server:', e);

        // https://github.com/mozilla-iot/gateway/issues/358
        // we should store this error and display to the user on
        // settings page to allow him to retry
        callback(e);
        return;
      }
    }
  } catch (err) {
    console.error('Registration failed:', err);
    callback(err.detail || err.message.substring(0, err.message.indexOf('\n')));
  }

  callback();
}

/**
 * Try to renew the certificates associated with this domain.
 */
async function renew() {
  if (DEBUG) {
    console.debug('Starting renewal.');
  }

  const leChallenge = leChallengeFs.create({
    webrootPath: Constants.BUILD_STATIC_PATH,
    debug: DEBUG,
  });
  const leStore = leStoreCertbot.create({
    webrootPath: Constants.BUILD_STATIC_PATH,
    configDir: path.join(UserProfile.baseDir, 'etc'),
    logsDir: path.join(UserProfile.baseDir, 'var', 'log'),
    workDir: path.join(UserProfile.baseDir, 'var', 'lib'),
    debug: DEBUG,
  });

  let tunnelToken;
  try {
    tunnelToken = await Settings.get('tunneltoken');
  } catch (e) {
    console.error('Tunnel token not set!');
    return;
  }

  const domain = `${tunnelToken.name}.${config.get('ssltunnel.domain')}`;

  const le = greenlock.create({
    server: 'https://acme-v02.api.letsencrypt.org/directory',
    challengeType: 'http-01',
    challenges: {
      'http-01': leChallenge,
    },
    approveDomains: [
      domain,
    ],
    agreeTos: true,
    communityMember: false,
    securityUpdates: false,
    telemetry: false,
    store: leStore,
    version: 'v02',
    renewWithin: 14 * 24 * 60 * 60 * 1000,  // 2 weeks
    renewBy: 10 * 24 * 60 * 60 * 1000,      // 10 days
    debug: DEBUG,
  });

  try {
    const results = await le.register({
      domains: [
        domain,
      ],
      email: config.get('ssltunnel.certemail'),
      agreeTos: true,
      rsaKeySize: 2048,
      challengeType: 'http-01',
      waitForRenewal: true,
      debug: DEBUG,
    });

    if (DEBUG) {
      console.debug('Renewal success:', results);
    }

    writeCertificates(results);
  } catch (err) {
    console.error('Renewal failed:', err);
  }
}

module.exports = {
  register,
  renew,
};