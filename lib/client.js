/* eslint-disable max-classes-per-file */

const { inspect } = require('util');
const stdhttp = require('http');
const crypto = require('crypto');
const { strict: assert } = require('assert');
const querystring = require('querystring');
const url = require('url');

const jose = require('jose');
const base64url = require('base64url');
const defaultsDeep = require('lodash/defaultsDeep');
const defaults = require('lodash/defaults');
const merge = require('lodash/merge');
const isPlainObject = require('lodash/isPlainObject');
const tokenHash = require('oidc-token-hash');

const { assertSigningAlgValuesSupport, assertIssuerConfiguration } = require('./helpers/assert');
const pick = require('./helpers/pick');
const processResponse = require('./helpers/process_response');
const TokenSet = require('./token_set');
const { OPError, RPError } = require('./errors');
const now = require('./helpers/unix_timestamp');
const { random } = require('./helpers/generators');
const request = require('./helpers/request');
const {
  CALLBACK_PROPERTIES, CLIENT_DEFAULTS, JWT_CONTENT, CLOCK_TOLERANCE,
} = require('./helpers/consts');
const issuerRegistry = require('./issuer_registry');
const instance = require('./helpers/weak_cache');
const { authenticatedPost, resolveResponseType, resolveRedirectUri } = require('./helpers/client');
const DeviceFlowHandle = require('./device_flow_handle');

function pickCb(input) {
  return pick(input, ...CALLBACK_PROPERTIES);
}

function bearer(token) {
  return `Bearer ${token}`;
}

function cleanUpClaims(claims) {
  if (Object.keys(claims._claim_names).length === 0) {
    delete claims._claim_names;
  }
  if (Object.keys(claims._claim_sources).length === 0) {
    delete claims._claim_sources;
  }
}

function assignClaim(target, source, sourceName) {
  return ([claim, inSource]) => {
    if (inSource === sourceName) {
      if (source[claim] === undefined) {
        throw new RPError(`expected claim "${claim}" in "${sourceName}"`);
      }
      target[claim] = source[claim];
      delete target._claim_names[claim];
    }
  };
}

function getFromJWT(jwt, position, claim) {
  if (typeof jwt !== 'string') {
    throw new RPError({
      message: `invalid JWT type, expected a string, got: ${typeof jwt}`,
      jwt,
    });
  }
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new RPError({
      message: 'invalid JWT format, expected three parts',
      jwt,
    });
  }
  const parsed = JSON.parse(base64url.decode(parts[position]));
  return typeof claim === 'undefined' ? parsed : parsed[claim];
}

function getSub(jwt) {
  return getFromJWT(jwt, 1, 'sub');
}

function getIss(jwt) {
  return getFromJWT(jwt, 1, 'iss');
}

function getHeader(jwt) {
  return getFromJWT(jwt, 0);
}

function getPayload(jwt) {
  return getFromJWT(jwt, 1);
}

function verifyPresence(payload, jwt, prop) {
  if (payload[prop] === undefined) {
    throw new RPError({
      message: `missing required JWT property ${prop}`,
      jwt,
    });
  }
}

function authorizationParams(params) {
  const authParams = {
    client_id: this.client_id,
    scope: 'openid',
    response_type: resolveResponseType.call(this),
    redirect_uri: resolveRedirectUri.call(this),
    ...params,
  };

  Object.entries(authParams).forEach(([key, value]) => {
    if (value === null || value === undefined) {
      delete authParams[key];
    } else if (key === 'claims' && typeof value === 'object') {
      authParams[key] = JSON.stringify(value);
    } else if (key === 'resource' && Array.isArray(value)) {
      authParams[key] = value;
    } else if (typeof value !== 'string') {
      authParams[key] = String(value);
    }
  });

  if (authParams.response_type && authParams.response_type.split(' ').includes('id_token') && !authParams.nonce) {
    throw new TypeError('nonce MUST be provided for implicit and hybrid flows');
  }

  return authParams;
}

async function claimJWT(jwt) {
  const iss = getIss(jwt);
  const keyDef = getHeader(jwt);
  if (!keyDef.alg) {
    throw new RPError({
      message: 'claim source is missing JWT header alg property',
      jwt,
    });
  }

  if (keyDef.alg === 'none') {
    return getPayload(jwt);
  }

  let key;
  if (!iss || iss === this.issuer.issuer) {
    key = await this.issuer.key(keyDef);
  } else if (issuerRegistry.has(iss)) {
    key = await issuerRegistry.get(iss).key(keyDef);
  } else {
    const discovered = await this.issuer.constructor.discover(iss);
    key = await discovered.key(keyDef);
  }

  return jose.JWS.verify(jwt, key);
}

function getKeystore(jwks) {
  const keystore = jose.JWKS.asKeyStore(jwks);
  if (keystore.all().some((key) => key.type !== 'private')) {
    throw new TypeError('jwks must only contain private keys');
  }
  return keystore;
}

// if an OP doesnt support client_secret_basic but supports client_secret_post, use it instead
// this is in place to take care of most common pitfalls when first using discovered Issuers without
// the support for default values defined by Discovery 1.0
function checkBasicSupport(client, metadata, properties) {
  try {
    const supported = client.issuer.token_endpoint_auth_methods_supported;
    if (!supported.includes(properties.token_endpoint_auth_method)) {
      if (supported.includes('client_secret_post')) {
        properties.token_endpoint_auth_method = 'client_secret_post';
      }
    }
  } catch (err) {}
}

function handleCommonMistakes(client, metadata, properties) {
  if (!metadata.token_endpoint_auth_method) { // if no explicit value was provided
    checkBasicSupport(client, metadata, properties);
  }

  // :fp: c'mon people... RTFM
  if (metadata.redirect_uri) {
    if (metadata.redirect_uris) {
      throw new TypeError('provide a redirect_uri or redirect_uris, not both');
    }
    properties.redirect_uris = [metadata.redirect_uri];
    delete properties.redirect_uri;
  }

  if (metadata.response_type) {
    if (metadata.response_types) {
      throw new TypeError('provide a response_type or response_types, not both');
    }
    properties.response_types = [metadata.response_type];
    delete properties.response_type;
  }
}

function getDefaultsForEndpoint(endpoint, issuer, properties) {
  if (!issuer[`${endpoint}_endpoint`]) return;

  const tokenEndpointAuthMethod = properties.token_endpoint_auth_method;
  const tokenEndpointAuthSigningAlg = properties.token_endpoint_auth_signing_alg;

  const eam = `${endpoint}_endpoint_auth_method`;
  const easa = `${endpoint}_endpoint_auth_signing_alg`;

  if (properties[eam] === undefined && properties[easa] === undefined) {
    if (tokenEndpointAuthMethod !== undefined) {
      properties[eam] = tokenEndpointAuthMethod;
    }
    if (tokenEndpointAuthSigningAlg !== undefined) {
      properties[easa] = tokenEndpointAuthSigningAlg;
    }
  }
}

class BaseClient {}

module.exports = (issuer, aadIssValidation = false) => class Client extends BaseClient {
  /**
   * @name constructor
   * @api public
   */
  constructor(metadata = {}, jwks) {
    super();

    if (typeof metadata.client_id !== 'string' || !metadata.client_id) {
      throw new TypeError('client_id is required');
    }

    const properties = { ...CLIENT_DEFAULTS, ...metadata };

    handleCommonMistakes(this, metadata, properties);

    assertSigningAlgValuesSupport('token', this.issuer, properties);

    ['introspection', 'revocation'].forEach((endpoint) => {
      getDefaultsForEndpoint(endpoint, this.issuer, properties);
      assertSigningAlgValuesSupport(endpoint, this.issuer, properties);
    });

    Object.entries(properties).forEach(([key, value]) => {
      instance(this).get('metadata').set(key, value);
      if (!this[key]) {
        Object.defineProperty(this, key, {
          get() { return instance(this).get('metadata').get(key); },
          enumerable: true,
        });
      }
    });

    if (jwks !== undefined) {
      const keystore = getKeystore.call(this, jwks);
      instance(this).set('keystore', keystore);
    }

    this[CLOCK_TOLERANCE] = 0;
  }

  /**
   * @name authorizationUrl
   * @api public
   */
  authorizationUrl(params = {}) {
    if (!isPlainObject(params)) {
      throw new TypeError('params must be a plain object');
    }
    assertIssuerConfiguration(this.issuer, 'authorization_endpoint');
    const target = url.parse(this.issuer.authorization_endpoint, true);
    target.search = null;
    Object.assign(target.query, authorizationParams.call(this, params));
    return url.format(target);
  }

  /**
   * @name authorizationPost
   * @api public
   */
  authorizationPost(params = {}) {
    if (!isPlainObject(params)) {
      throw new TypeError('params must be a plain object');
    }
    const inputs = authorizationParams.call(this, params);
    const formInputs = Object.keys(inputs)
      .map((name) => `<input type="hidden" name="${name}" value="${inputs[name]}"/>`).join('\n');

    return `<!DOCTYPE html>
<head>
  <title>Requesting Authorization</title>
</head>
<body onload="javascript:document.forms[0].submit()">
  <form method="post" action="${this.issuer.authorization_endpoint}">
    ${formInputs}
  </form>
</body>
</html>`;
  }

  /**
   * @name endSessionUrl
   * @api public
   */
  endSessionUrl(params = {}) {
    assertIssuerConfiguration(this.issuer, 'end_session_endpoint');

    const {
      0: postLogout,
      length,
    } = this.post_logout_redirect_uris || [];

    const {
      post_logout_redirect_uri = length === 1 ? postLogout : undefined,
    } = params;

    let hint = params.id_token_hint;

    if (hint instanceof TokenSet) {
      if (!hint.id_token) {
        throw new TypeError('id_token not present in TokenSet');
      }
      hint = hint.id_token;
    }

    const target = url.parse(this.issuer.end_session_endpoint, true);
    target.search = null;
    target.query = Object.assign(params, target.query, {
      post_logout_redirect_uri,
      id_token_hint: hint,
    });

    Object.entries(target.query).forEach(([key, value]) => {
      if (value === null || value === undefined) {
        delete target.query[key];
      }
    });

    return url.format(target);
  }

  /**
   * @name callbackParams
   * @api public
   */
  callbackParams(input) { // eslint-disable-line class-methods-use-this
    const isIncomingMessage = input instanceof stdhttp.IncomingMessage
      || (input && input.method && input.url);
    const isString = typeof input === 'string';

    if (!isString && !isIncomingMessage) {
      throw new TypeError('#callbackParams only accepts string urls, http.IncomingMessage or a lookalike');
    }

    if (isIncomingMessage) {
      switch (input.method) {
        case 'GET':
          return pickCb(url.parse(input.url, true).query);
        case 'POST':
          if (input.body === undefined) {
            throw new TypeError('incoming message body missing, include a body parser prior to this method call');
          }
          switch (typeof input.body) {
            case 'object':
            case 'string':
              if (Buffer.isBuffer(input.body)) {
                return pickCb(querystring.parse(input.body.toString('utf-8')));
              }
              if (typeof input.body === 'string') {
                return pickCb(querystring.parse(input.body));
              }

              return pickCb(input.body);
            default:
              throw new TypeError('invalid IncomingMessage body object');
          }
        default:
          throw new TypeError('invalid IncomingMessage method');
      }
    } else {
      return pickCb(url.parse(input, true).query);
    }
  }

  /**
   * @name callback
   * @api public
   */
  async callback(
    redirectUri,
    parameters,
    checks = {},
    { exchangeBody, clientAssertionPayload } = {},
  ) {
    const params = pickCb(parameters);

    if (this.default_max_age && !checks.max_age) {
      checks.max_age = this.default_max_age;
    }

    if (params.state && !checks.state) {
      throw new TypeError('checks.state argument is missing');
    }

    if (!params.state && checks.state) {
      throw new RPError({
        message: 'state missing from the response',
        checks,
        params,
      });
    }

    if (checks.state !== params.state) {
      throw new RPError({
        printf: ['state mismatch, expected %s, got: %s', checks.state, params.state],
        checks,
        params,
      });
    }

    if (params.error) {
      throw new OPError(params);
    }

    const RESPONSE_TYPE_REQUIRED_PARAMS = {
      code: ['code'],
      id_token: ['id_token'],
      token: ['access_token', 'token_type'],
    };

    if (checks.response_type) {
      for (const type of checks.response_type.split(' ')) { // eslint-disable-line no-restricted-syntax
        if (type === 'none') {
          if (params.code || params.id_token || params.access_token) {
            throw new RPError({
              message: 'unexpected params encountered for "none" response',
              checks,
              params,
            });
          }
        } else {
          for (const param of RESPONSE_TYPE_REQUIRED_PARAMS[type]) { // eslint-disable-line no-restricted-syntax, max-len
            if (!params[param]) {
              throw new RPError({
                message: `${param} missing from response`,
                checks,
                params,
              });
            }
          }
        }
      }
    }

    if (params.id_token) {
      const tokenset = new TokenSet(params);
      await this.decryptIdToken(tokenset);
      await this.validateIdToken(tokenset, checks.nonce, 'authorization', checks.max_age, checks.state);

      if (!params.code) {
        return tokenset;
      }
    }

    if (params.code) {
      const tokenset = await this.grant({
        ...exchangeBody,
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: redirectUri,
        code_verifier: checks.code_verifier,
      }, { clientAssertionPayload });

      await this.decryptIdToken(tokenset);
      await this.validateIdToken(tokenset, checks.nonce, 'token', checks.max_age);

      if (params.session_state) {
        tokenset.session_state = params.session_state;
      }

      return tokenset;
    }

    return new TokenSet(params);
  }

  /**
   * @name oauthCallback
   * @api public
   */
  async oauthCallback(
    redirectUri,
    parameters,
    checks = {},
    { exchangeBody, clientAssertionPayload } = {},
  ) {
    const params = pickCb(parameters);

    if (params.state && !checks.state) {
      throw new TypeError('checks.state argument is missing');
    }

    if (!params.state && checks.state) {
      throw new RPError({
        message: 'state missing from the response',
        checks,
        params,
      });
    }

    if (checks.state !== params.state) {
      throw new RPError({
        printf: ['state mismatch, expected %s, got: %s', checks.state, params.state],
        checks,
        params,
      });
    }

    if (params.error) {
      throw new OPError(params);
    }

    const RESPONSE_TYPE_REQUIRED_PARAMS = {
      code: ['code'],
      token: ['access_token', 'token_type'],
    };

    if (checks.response_type) {
      for (const type of checks.response_type.split(' ')) { // eslint-disable-line no-restricted-syntax
        if (type === 'none') {
          if (params.code || params.id_token || params.access_token) {
            throw new RPError({
              message: 'unexpected params encountered for "none" response',
              checks,
              params,
            });
          }
        }

        if (RESPONSE_TYPE_REQUIRED_PARAMS[type]) {
          for (const param of RESPONSE_TYPE_REQUIRED_PARAMS[type]) { // eslint-disable-line no-restricted-syntax, max-len
            if (!params[param]) {
              throw new RPError({
                message: `${param} missing from response`,
                checks,
                params,
              });
            }
          }
        }
      }
    }

    if (params.code) {
      return this.grant({
        ...exchangeBody,
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: redirectUri,
        code_verifier: checks.code_verifier,
      }, { clientAssertionPayload });
    }

    return new TokenSet(params);
  }

  /**
   * @name decryptIdToken
   * @api private
   */
  async decryptIdToken(token, use) {
    if (!use) use = 'id_token'; // eslint-disable-line no-param-reassign

    if (!this[`${use}_encrypted_response_alg`]) {
      return token;
    }

    let idToken = token;

    if (idToken instanceof TokenSet) {
      if (!idToken.id_token) {
        throw new TypeError('id_token not present in TokenSet');
      }
      idToken = idToken.id_token;
    }

    const expectedAlg = this[`${use}_encrypted_response_alg`];
    const expectedEnc = this[`${use}_encrypted_response_enc`];

    const header = JSON.parse(base64url.decode(idToken.split('.')[0]));

    if (header.alg !== expectedAlg) {
      throw new RPError({
        printf: ['unexpected JWE alg received, expected %s, got: %s', expectedAlg, header.alg],
        jwt: idToken,
      });
    }

    if (header.enc !== expectedEnc) {
      throw new RPError({
        printf: ['unexpected JWE enc received, expected %s, got: %s', expectedEnc, header.enc],
        jwt: idToken,
      });
    }

    let keyOrStore;

    if (expectedAlg.match(/^(?:RSA|ECDH)/)) {
      keyOrStore = instance(this).get('keystore');
    } else {
      keyOrStore = await this.joseSecret(expectedAlg === 'dir' ? expectedEnc : expectedAlg);
    }

    const payload = jose.JWE.decrypt(idToken, keyOrStore);
    const result = payload.toString('utf8');

    if (token instanceof TokenSet) {
      token.id_token = result;
      return token;
    }

    return result;
  }

  /**
   * @name validateIdToken
   * @api private
   */
  async validateIdToken(tokenSet, nonce, returnedBy, maxAge, state) {
    let idToken = tokenSet;

    const expectedAlg = returnedBy === 'userinfo' ? this.userinfo_signed_response_alg : this.id_token_signed_response_alg;

    const isTokenSet = idToken instanceof TokenSet;

    if (isTokenSet) {
      if (!idToken.id_token) {
        throw new TypeError('id_token not present in TokenSet');
      }
      idToken = idToken.id_token;
    }

    idToken = String(idToken);

    const timestamp = now();
    const parts = idToken.split('.');
    const header = JSON.parse(base64url.decode(parts[0]));
    const payload = JSON.parse(base64url.decode(parts[1]));

    if (header.alg !== expectedAlg) {
      throw new RPError({
        printf: ['unexpected JWT alg received, expected %s, got: %s', expectedAlg, header.alg],
        jwt: idToken,
      });
    }

    if (returnedBy !== 'userinfo') {
      ['iss', 'sub', 'aud', 'exp', 'iat'].forEach(verifyPresence.bind(undefined, payload, idToken));
    }

    if (payload.iss !== undefined) {
      let expectedIss = this.issuer.issuer;

      if (aadIssValidation) {
        expectedIss = this.issuer.issuer.replace('{tenantid}', payload.tid);
      }

      if (payload.iss !== expectedIss) {
        throw new RPError({
          printf: ['unexpected iss value, expected %s, got: %s', expectedIss, payload.iss],
          jwt: idToken,
        });
      }
    }

    if (payload.iat !== undefined) {
      if (!Number.isInteger(payload.iat)) {
        throw new RPError({
          message: 'JWT iat claim must be a JSON number integer',
          jwt: idToken,
        });
      }
      if (payload.iat > timestamp + this[CLOCK_TOLERANCE]) {
        throw new RPError({
          printf: ['id_token issued in the future, now %i, iat %i', timestamp + this[CLOCK_TOLERANCE], payload.iat],
          jwt: idToken,
        });
      }
    }

    if (payload.nbf !== undefined) {
      if (!Number.isInteger(payload.nbf)) {
        throw new RPError({
          message: 'JWT nbf claim must be a JSON number integer',
          jwt: idToken,
        });
      }
      if (payload.nbf > timestamp + this[CLOCK_TOLERANCE]) {
        throw new RPError({
          printf: ['id_token not active yet, now %i, nbf %i', timestamp + this[CLOCK_TOLERANCE], payload.nbf],
          jwt: idToken,
        });
      }
    }

    if (maxAge || (maxAge !== null && this.require_auth_time)) {
      if (!payload.auth_time) {
        throw new RPError({
          message: 'missing required JWT property auth_time',
          jwt: idToken,
        });
      }
      if (!Number.isInteger(payload.auth_time)) {
        throw new RPError({
          message: 'JWT auth_time claim must be a JSON number integer',
          jwt: idToken,
        });
      }
    }

    if (maxAge && (payload.auth_time + maxAge < timestamp - this[CLOCK_TOLERANCE])) {
      throw new RPError({
        printf: ['too much time has elapsed since the last End-User authentication, max_age %i, auth_time: %i, now %i', maxAge, payload.auth_time, timestamp - this[CLOCK_TOLERANCE]],
        jwt: idToken,
      });
    }

    if (nonce !== null && (payload.nonce || nonce !== undefined) && payload.nonce !== nonce) {
      throw new RPError({
        printf: ['nonce mismatch, expected %s, got: %s', nonce, payload.nonce],
        jwt: idToken,
      });
    }

    if (payload.exp !== undefined) {
      if (!Number.isInteger(payload.exp)) {
        throw new RPError({
          message: 'JWT exp claim must be a JSON number integer',
          jwt: idToken,
        });
      }
      if (timestamp - this[CLOCK_TOLERANCE] >= payload.exp) {
        throw new RPError({
          printf: ['id_token expired, now %i, exp %i', timestamp - this[CLOCK_TOLERANCE], payload.exp],
          jwt: idToken,
        });
      }
    }

    if (payload.aud !== undefined) {
      if (Array.isArray(payload.aud)) {
        if (payload.aud.length > 1 && !payload.azp) {
          throw new RPError({
            message: 'missing required JWT property azp',
            jwt: idToken,
          });
        }

        if (!payload.aud.includes(this.client_id)) {
          throw new RPError({
            printf: ['aud is missing the client_id, expected %s to be included in %j', this.client_id, payload.aud],
            jwt: idToken,
          });
        }
      } else if (payload.aud !== this.client_id) {
        throw new RPError({
          printf: ['aud mismatch, expected %s, got: %s', this.client_id, payload.aud],
          jwt: idToken,
        });
      }
    }

    if (payload.azp !== undefined && payload.azp !== this.client_id) {
      throw new RPError({
        printf: ['azp must be the client_id, expected %s, got: %s', this.client_id, payload.azp],
        jwt: idToken,
      });
    }

    if (returnedBy === 'authorization') {
      if (!payload.at_hash && tokenSet.access_token) {
        throw new RPError({
          message: 'missing required property at_hash',
          jwt: idToken,
        });
      }
      if (!payload.c_hash && tokenSet.code) {
        throw new RPError({
          message: 'missing required property c_hash',
          jwt: idToken,
        });
      }

      if (payload.s_hash) {
        if (!state) {
          throw new TypeError('cannot verify s_hash, "checks.state" property not provided');
        }
        if (!tokenHash(payload.s_hash, state, header.alg)) {
          throw new RPError({
            printf: ['s_hash mismatch, expected %s, got: %s', tokenHash.generate(state, header.alg), payload.s_hash],
            jwt: idToken,
          });
        }
      }
    }

    if (tokenSet.access_token && payload.at_hash !== undefined) {
      if (!tokenHash(payload.at_hash, tokenSet.access_token, header.alg)) {
        throw new RPError({
          printf: ['at_hash mismatch, expected %s, got: %s', tokenHash.generate(tokenSet.access_token, header.alg), payload.at_hash],
          jwt: idToken,
        });
      }
    }

    if (tokenSet.code && payload.c_hash !== undefined) {
      if (!tokenHash(payload.c_hash, tokenSet.code, header.alg)) {
        throw new RPError({
          printf: ['c_hash mismatch, expected %s, got: %s', tokenHash.generate(tokenSet.code, header.alg), payload.c_hash],
          jwt: idToken,
        });
      }
    }

    if (header.alg === 'none') {
      return tokenSet;
    }

    let key;

    if (header.alg.startsWith('HS')) {
      key = await this.joseSecret();
    } else {
      key = await this.issuer.key(header);
    }

    try {
      jose.JWS.verify(idToken, key);
    } catch (err) {
      throw new RPError({
        message: 'failed to validate JWT signature',
        jwt: idToken,
      });
    }

    return tokenSet;
  }

  /**
   * @name refresh
   * @api public
   */
  async refresh(refreshToken, { exchangeBody, clientAssertionPayload } = {}) {
    let token = refreshToken;

    if (token instanceof TokenSet) {
      if (!token.refresh_token) {
        throw new TypeError('refresh_token not present in TokenSet');
      }
      token = token.refresh_token;
    }

    const tokenset = await this.grant({
      ...exchangeBody,
      grant_type: 'refresh_token',
      refresh_token: String(token),
    }, { clientAssertionPayload });

    if (tokenset.id_token) {
      await this.decryptIdToken(tokenset);
      await this.validateIdToken(tokenset, null, 'token', null);
    }

    return tokenset;
  }

  /**
   * @name userinfo
   * @api public
   */
  async userinfo(accessToken, options) {
    assertIssuerConfiguration(this.issuer, 'userinfo_endpoint');
    let token = accessToken;
    const opts = merge({
      verb: 'get',
      via: 'header',
    }, options);

    if (token instanceof TokenSet) {
      if (!token.access_token) {
        throw new TypeError('access_token not present in TokenSet');
      }
      token = token.access_token;
    }

    const verb = String(opts.verb).toUpperCase();
    let requestOpts;

    switch (opts.via) {
      case 'query':
        if (verb !== 'GET') {
          throw new TypeError('providers should only parse query strings for GET requests');
        }
        requestOpts = { query: { access_token: token } };
        break;
      case 'body':
        if (verb !== 'POST') {
          throw new TypeError('can only send body on POST');
        }
        requestOpts = { form: true, body: { access_token: token } };
        break;
      default:
        requestOpts = { headers: { Authorization: bearer(token) } };
    }

    if (opts.params) {
      if (verb === 'POST') {
        defaultsDeep(requestOpts, { body: opts.params });
      } else {
        defaultsDeep(requestOpts, { query: opts.params });
      }
    }

    const jwt = !!(this.userinfo_signed_response_alg
      || this.userinfo_encrypted_response_alg
      || this.userinfo_encrypted_response_enc);

    if (jwt) {
      defaultsDeep(requestOpts, { headers: { Accept: 'application/jwt' } });
    }

    const mTLS = !!this.tls_client_certificate_bound_access_tokens;

    let targetUrl;
    if (mTLS) {
      try {
        targetUrl = this.issuer.mtls_endpoint_aliases.userinfo_endpoint;
      } catch (err) {}
    }

    targetUrl = targetUrl || this.issuer.userinfo_endpoint;

    const response = await request.call(this, {
      ...requestOpts,
      method: verb,
      url: targetUrl,
      json: !jwt,
    }, { mTLS });

    let parsed = processResponse(response, { bearer: true });

    if (jwt) {
      if (!JWT_CONTENT.test(response.headers['content-type'])) {
        throw new RPError({
          message: 'expected application/jwt response from the userinfo_endpoint',
          response,
        });
      }

      const userinfo = await this.decryptIdToken(response.body, 'userinfo');
      if (!this.userinfo_signed_response_alg) {
        try {
          parsed = JSON.parse(userinfo);
          assert(isPlainObject(parsed));
        } catch (err) {
          throw new RPError({
            message: 'failed to parse userinfo JWE payload as JSON',
            jwt: userinfo,
          });
        }
      } else {
        await this.validateIdToken(userinfo, null, 'userinfo', null);
        parsed = JSON.parse(base64url.decode(userinfo.split('.')[1]));
      }
    }

    if (accessToken.id_token) {
      const expectedSub = getSub(accessToken.id_token);
      if (parsed.sub !== expectedSub) {
        throw new RPError({
          printf: ['userinfo sub mismatch, expected %s, got: %s', expectedSub, parsed.sub],
          body: parsed,
          jwt: accessToken.id_token,
        });
      }
    }

    return parsed;
  }

  /**
   * @name derivedKey
   * @api private
   */
  async derivedKey(len) {
    const cacheKey = `${len}_key`;
    if (instance(this).has(cacheKey)) {
      return instance(this).get(cacheKey);
    }

    const derivedBuffer = crypto.createHash('sha256')
      .update(this.client_secret)
      .digest()
      .slice(0, len / 8);

    const key = jose.JWK.asKey({ k: base64url.encode(derivedBuffer), kty: 'oct' });
    instance(this).set(cacheKey, key);

    return key;
  }

  /**
   * @name joseSecret
   * @api private
   */
  async joseSecret(alg) {
    if (!this.client_secret) {
      throw new TypeError('client_secret is required');
    }
    if (/^A(\d{3})(?:GCM)?KW$/.test(alg)) {
      return this.derivedKey(parseInt(RegExp.$1, 10));
    }

    if (/^A(\d{3})(?:GCM|CBC-HS(\d{3}))$/.test(alg)) {
      return this.derivedKey(parseInt(RegExp.$2 || RegExp.$1, 10));
    }

    if (instance(this).has('jose_secret')) {
      return instance(this).get('jose_secret');
    }

    const key = jose.JWK.asKey({ k: base64url.encode(this.client_secret), kty: 'oct' });
    instance(this).set('jose_secret', key);

    return key;
  }

  /**
   * @name grant
   * @api public
   */
  async grant(body, { clientAssertionPayload } = {}) {
    assertIssuerConfiguration(this.issuer, 'token_endpoint');
    const response = await authenticatedPost.call(
      this,
      'token',
      {
        form: true,
        body,
        json: true,
      },
      { clientAssertionPayload },
    );
    const responseBody = processResponse(response);

    return new TokenSet(responseBody);
  }

  /**
   * @name deviceAuthorization
   * @api public
   */
  async deviceAuthorization(params = {}, { exchangeBody, clientAssertionPayload } = {}) {
    assertIssuerConfiguration(this.issuer, 'device_authorization_endpoint');
    assertIssuerConfiguration(this.issuer, 'token_endpoint');

    const body = authorizationParams.call(this, {
      client_id: this.client_id,
      redirect_uri: null,
      response_type: null,
      ...params,
    });

    const response = await authenticatedPost.call(
      this,
      'device_authorization',
      {
        form: true,
        body,
        json: true,
      },
      { clientAssertionPayload, endpointAuthMethod: 'token' },
    );
    const responseBody = processResponse(response);

    return new DeviceFlowHandle({
      client: this,
      exchangeBody,
      clientAssertionPayload,
      response: responseBody,
      maxAge: params.max_age,
    });
  }

  /**
   * @name revoke
   * @api public
   */
  async revoke(token, hint, { revokeBody, clientAssertionPayload } = {}) {
    assertIssuerConfiguration(this.issuer, 'revocation_endpoint');
    if (hint !== undefined && typeof hint !== 'string') {
      throw new TypeError('hint must be a string');
    }

    const body = { ...revokeBody, token };

    if (hint) {
      body.token_type_hint = hint;
    }

    const response = await authenticatedPost.call(
      this,
      'revocation', {
        body,
        form: true,
      }, { clientAssertionPayload },
    );
    processResponse(response, { body: false });
  }

  /**
   * @name introspect
   * @api public
   */
  async introspect(token, hint, { introspectBody, clientAssertionPayload } = {}) {
    assertIssuerConfiguration(this.issuer, 'introspection_endpoint');
    if (hint !== undefined && typeof hint !== 'string') {
      throw new TypeError('hint must be a string');
    }

    const body = { ...introspectBody, token };
    if (hint) {
      body.token_type_hint = hint;
    }

    const response = await authenticatedPost.call(
      this,
      'introspection',
      { body, form: true, json: true },
      { clientAssertionPayload },
    );

    const responseBody = processResponse(response);

    return responseBody;
  }

  /**
   * @name fetchDistributedClaims
   * @api public
   */
  async fetchDistributedClaims(claims, tokens = {}) {
    if (!isPlainObject(claims)) {
      throw new TypeError('claims argument must be a plain object');
    }

    if (!isPlainObject(claims._claim_sources)) {
      return claims;
    }

    if (!isPlainObject(claims._claim_names)) {
      return claims;
    }

    const distributedSources = Object.entries(claims._claim_sources)
      .filter(([, value]) => value && value.endpoint);

    await Promise.all(distributedSources.map(async ([sourceName, def]) => {
      try {
        const requestOpts = {
          headers: {
            Accept: 'application/jwt',
            Authorization: bearer(def.access_token || tokens[sourceName]),
          },
        };

        const response = await request.call(this, {
          ...requestOpts,
          method: 'GET',
          url: def.endpoint,
        });
        const body = processResponse(response, { bearer: true });

        const decoded = await claimJWT.call(this, body);
        delete claims._claim_sources[sourceName];
        Object.entries(claims._claim_names).forEach(assignClaim(claims, decoded, sourceName));
      } catch (err) {
        err.src = sourceName;
        throw err;
      }
    }));

    cleanUpClaims(claims);
    return claims;
  }

  /**
   * @name unpackAggregatedClaims
   * @api public
   */
  async unpackAggregatedClaims(claims) {
    if (!isPlainObject(claims)) {
      throw new TypeError('claims argument must be a plain object');
    }

    if (!isPlainObject(claims._claim_sources)) {
      return claims;
    }

    if (!isPlainObject(claims._claim_names)) {
      return claims;
    }

    const aggregatedSources = Object.entries(claims._claim_sources)
      .filter(([, value]) => value && value.JWT);

    await Promise.all(aggregatedSources.map(async ([sourceName, def]) => {
      try {
        const decoded = await claimJWT.call(this, def.JWT);
        delete claims._claim_sources[sourceName];
        Object.entries(claims._claim_names).forEach(assignClaim(claims, decoded, sourceName));
      } catch (err) {
        err.src = sourceName;
        throw err;
      }
    }));

    cleanUpClaims(claims);
    return claims;
  }

  /**
   * @name register
   * @api public
   */
  static async register(properties, { initialAccessToken, jwks } = {}) {
    assertIssuerConfiguration(this.issuer, 'registration_endpoint');

    if (jwks !== undefined && !(properties.jwks || properties.jwks_uri)) {
      const keystore = getKeystore.call(this, jwks);
      properties.jwks = keystore.toJWKS(false);
    }

    const response = await request.call(this, {
      headers: initialAccessToken ? { Authorization: bearer(initialAccessToken) } : undefined,
      json: true,
      body: properties,
      url: this.issuer.registration_endpoint,
      method: 'POST',
    });
    const responseBody = processResponse(response, { statusCode: 201, bearer: true });

    return new this(responseBody, jwks);
  }

  /**
   * @name metadata
   * @api public
   */
  get metadata() {
    const copy = {};
    instance(this).get('metadata').forEach((value, key) => {
      copy[key] = value;
    });
    return copy;
  }

  /**
   * @name fromUri
   * @api public
   */
  static async fromUri(registrationClientUri, registrationAccessToken, jwks) {
    const response = await request.call(this, {
      method: 'GET',
      url: registrationClientUri,
      json: true,
      headers: { Authorization: bearer(registrationAccessToken) },
    });
    const responseBody = processResponse(response, { bearer: true });

    return new this(responseBody, jwks);
  }

  /**
   * @name requestObject
   * @api public
   */
  async requestObject(requestObject = {}, algorithms = {}) {
    if (!isPlainObject(requestObject)) {
      throw new TypeError('requestObject must be a plain object');
    }

    defaults(algorithms, {
      sign: this.request_object_signing_alg,
      encrypt: {
        alg: this.request_object_encryption_alg,
        enc: this.request_object_encryption_enc,
      },
    }, {
      sign: 'none',
    });

    let signed;
    let key;

    const alg = algorithms.sign;
    const header = { alg, typ: 'JWT' };
    const payload = JSON.stringify(defaults({}, requestObject, {
      iss: this.client_id,
      aud: this.issuer.issuer,
      client_id: this.client_id,
      jti: random(),
      iat: now(),
      exp: now() + 300,
    }));

    if (alg === 'none') {
      signed = [
        base64url.encode(JSON.stringify(header)),
        base64url.encode(payload),
        '',
      ].join('.');
    } else {
      const symmetric = alg.startsWith('HS');
      if (symmetric) {
        key = await this.joseSecret();
      } else {
        const keystore = instance(this).get('keystore');

        if (!keystore) {
          throw new TypeError(`no keystore present for client, cannot sign using alg ${alg}`);
        }
        key = keystore.get({ alg, use: 'sig' });
        if (!key) {
          throw new TypeError(`no key to sign with found for alg ${alg}`);
        }
      }

      signed = jose.JWS.sign(payload, key, {
        ...header,
        kid: symmetric ? undefined : key.kid,
      });
    }

    if (!algorithms.encrypt.alg) {
      return signed;
    }

    const fields = { alg: algorithms.encrypt.alg, enc: algorithms.encrypt.enc, cty: 'JWT' };

    if (fields.alg.match(/^(RSA|ECDH)/)) {
      key = await this.issuer.key({
        alg: fields.alg,
        enc: fields.enc,
        use: 'enc',
      }, true);
    } else {
      key = await this.joseSecret(fields.alg === 'dir' ? fields.enc : fields.alg);
    }

    return jose.JWE.encrypt(signed, key, {
      ...fields,
      kid: key.kty === 'oct' ? undefined : key.kid,
    });
  }


  /**
   * @name issuer
   * @api public
   */
  static get issuer() {
    return issuer;
  }


  /**
   * @name issuer
   * @api public
   */
  get issuer() { // eslint-disable-line class-methods-use-this
    return issuer;
  }

  /* istanbul ignore next */
  [inspect.custom]() {
    return `${this.constructor.name} ${inspect(this.metadata, {
      depth: Infinity,
      colors: process.stdout.isTTY,
      compact: false,
      sorted: true,
    })}`;
  }
};

module.exports.BaseClient = BaseClient;
