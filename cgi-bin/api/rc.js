/**
 * POST   /cgi-bin/api/rc          -- 등록 (body: { name, config })
 * GET    /cgi-bin/api/rc?name=xxx -- 단건 조회
 * PUT    /cgi-bin/api/rc?name=xxx -- 수정 (body: config)
 * DELETE /cgi-bin/api/rc?name=xxx -- 제거
 */

const path = require('path');
const process = require('process');
const _argv = process.argv[1];
const ROOT = _argv.slice(0, _argv.lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const CGI = require(path.join(ROOT, 'src', 'cgi', 'cgi_util.js'));

const { name } = CGI.parseQuery();

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function applyPasswordFallback(nextConfig, currentConfig) {
  if (!nextConfig || typeof nextConfig !== 'object') return nextConfig;

  const nextSource = nextConfig.source;
  const nextTarget = nextConfig.target;
  const validSource = !!nextSource && typeof nextSource === 'object';
  const validTarget = !!nextTarget && typeof nextTarget === 'object';
  const sourcePasswordMissingOrEmpty = validSource
    && (!hasOwn(nextSource, 'password') || nextSource.password === '');
  const targetPasswordMissingOrEmpty = validTarget
    && (!hasOwn(nextTarget, 'password') || nextTarget.password === '');

  if (sourcePasswordMissingOrEmpty && hasOwn(currentConfig?.source, 'password')) {
    nextSource.password = currentConfig.source.password;
  }

  if (targetPasswordMissingOrEmpty && hasOwn(currentConfig?.target, 'password')) {
    nextTarget.password = currentConfig.target.password;
  }

  return nextConfig;
}

function POST() {
  const body = CGI.readBody();
  if (!body.name) {
    CGI.reply({ ok: false, reason: 'name is required' });
  } else if (!body.config) {
    CGI.reply({ ok: false, reason: 'config is required' });
  } else if (CGI.readConfig(body.name)) {
    CGI.reply({ ok: false, reason: `replicator '${body.name}' already exists` });
  } else {
    try {
      CGI.validateColumnOrderTypes(body.config);
    } catch (err) {
      CGI.reply({ ok: false, reason: errorMessage(err) });
      return;
    }
    CGI.writeConfig(body.name, body.config);
    CGI.installService(body.name, (err) => {
      if (err) {
        CGI.deleteConfig(body.name);
        CGI.reply({ ok: false, reason: errorMessage(err) });
      } else {
        CGI.reply({ ok: true, data: { name: body.name } });
      }
    });
  }
}

function GET() {
  if (!name) return CGI.reply({ ok: false, reason: 'name is required' });
  const config = CGI.readConfig(name);
  if (!config) {
    CGI.reply({ ok: false, reason: `replicator '${name}' not found` });
  } else {
    const safeSource = { ...config.source };
    delete safeSource.password;
    const safeTarget = { ...config.target };
    delete safeTarget.password;
    const safeConfig = { ...config, source: safeSource, target: safeTarget };
    const checkpoints = CGI.readCheckpoints(name, config);
    CGI.reply({ ok: true, data: { name, config: safeConfig, checkpoints } });
  }
}

function PUT() {
  if (!name) return CGI.reply({ ok: false, reason: 'name is required' });
  const currentConfig = CGI.readConfig(name);
  if (!currentConfig) {
    CGI.reply({ ok: false, reason: `replicator '${name}' not found` });
  } else {
    const nextConfig = applyPasswordFallback(CGI.readBody(), currentConfig);
    try {
      CGI.validateColumnOrderTypes(nextConfig);
    } catch (err) {
      CGI.reply({ ok: false, reason: errorMessage(err) });
      return;
    }
    CGI.writeConfig(name, nextConfig);
    CGI.restartServiceIfRunning(name, (err) => {
      if (err) {
        CGI.reply({ ok: false, reason: errorMessage(err) });
      } else {
        CGI.reply({ ok: true, data: { name } });
      }
    });
  }
}

function DELETE() {
  if (!name) return CGI.reply({ ok: false, reason: 'name is required' });
  const config = CGI.readConfig(name);
  if (!config) {
    CGI.reply({ ok: false, reason: `replicator '${name}' not found` });
  } else {
    CGI.stopServiceIfRunning(name, (stopErr) => {
      if (stopErr) {
        CGI.reply({ ok: false, reason: errorMessage(stopErr) });
        return;
      }
      CGI.uninstallService(name, (err) => {
        if (err && !CGI.isMissingServiceError(err)) {
          CGI.reply({ ok: false, reason: errorMessage(err) });
        } else {
          const serviceDefinitionErr = CGI.deleteServiceDefinition(name);
          CGI.deleteCheckpoints(name, config);
          const pidErr = CGI.deletePid(name);
          const configErr = CGI.deleteConfig(name);
          if (serviceDefinitionErr) {
            CGI.reply({ ok: false, reason: errorMessage(serviceDefinitionErr) });
            return;
          }
          if (pidErr) {
            CGI.reply({ ok: false, reason: errorMessage(pidErr) });
            return;
          }
          if (configErr) {
            CGI.reply({ ok: false, reason: errorMessage(configErr) });
            return;
          }
          if (CGI.configExists(name)) {
            CGI.reply({ ok: false, reason: `failed to delete config '${name}'` });
            return;
          }
          CGI.reply({ ok: true });
        }
      });
    });
  }
}

const handlers = { POST, GET, PUT, DELETE };
const method = (process.env.get('REQUEST_METHOD') || 'GET').toUpperCase();
try {
  (handlers[method] || (() => CGI.reply({ ok: false, reason: 'method not allowed' })))();
} catch (err) {
  CGI.reply({ ok: false, reason: errorMessage(err) });
}
