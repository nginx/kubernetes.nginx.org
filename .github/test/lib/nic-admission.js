'use strict';
/* nic-admission.js — what NGINX Ingress Controller refuses at admission, ported
   from v5.7.0 (internal/k8s/validation.go, pkg/apis/configuration/validation,
   configmaps.go), for the value sweeps of every source module. refused(doc)
   returns the reasons one generated document would be refused; [] is admitted.
   One copy, so a rule learnt for one source is held for all of them. */

const nicTime = (s) => typeof s === 'string' && s.trim() !== '' && /^(\d+y)??\s*(\d+M)??\s*(\d+w)??\s*(\d+d)??\s*(\d+h)??\s*(\d+m)??\s*(\d+s?)??\s*(\d+ms)??$/.test(s);
const nicLb = (s) => ['round_robin', 'least_conn', 'ip_hash', 'random', 'random two', 'random two least_conn', 'least_time header', 'least_time last_byte', 'least_time header inflight', 'least_time last_byte inflight'].includes(s) || /^hash \S+( consistent)?$/.test(s);
const nicAddress = (s) => /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(s) || (/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(s) && s.includes(':'));
const nicHeader = /^[-A-Za-z0-9!#$%&'*+.^_`|~]+$/;
function refused(d) {
    const out = [];
    const ann = (d.metadata && d.metadata.annotations) || {};
    const check = (k, ok) => { if (k in ann && !ok(String(ann[k]))) out.push(k + '=' + ann[k]); };
    ['nginx.org/proxy-read-timeout', 'nginx.org/proxy-send-timeout', 'nginx.org/proxy-connect-timeout'].forEach((k) => check(k, nicTime));
    ['nginx.org/max-conns', 'nginx.org/max-fails'].forEach((k) => check(k, (v) => /^\d+$/.test(v)));
    check('nginx.org/lb-method', nicLb);
    ['nginx.org/ssl-redirect', 'nginx.org/redirect-to-https'].forEach((k) => check(k, (v) => /^(1|t|T|TRUE|true|True|0|f|F|FALSE|false|False)$/.test(v)));
    check('nginx.org/http-redirect-code', (v) => ['301', '302', '307', '308'].includes(v));
    check('nginx.org/limit-req-burst', (v) => /^\d+$/.test(v) && v !== '0');
    check('nginx.org/limit-req-reject-code', (v) => +v >= 400 && +v <= 599);
    ['nginx.org/proxy-set-headers', 'nginx.org/add-header'].forEach((k) => check(k, (v) => v.split(',').every((e) => nicHeader.test(e.split(':')[0].trim()))));
    // add-header splits on ":" into name, value and flag; the flag must be
    // "always" (validateAddHeaderAnnotation, v5.7.0).
    check('nginx.org/add-header', (v) => v.split(',').every((e) => { const p = e.split(':'); return p.length < 3 || (p.length === 3 && /^\s*always\s*$/i.test(p[2])); }));
    const s = d.spec || {};
    if (d.kind === 'Policy') {
        const rl = s.rateLimit;
        if (rl && (rl.burst !== undefined && !(rl.burst > 0) || rl.rejectCode < 400 || rl.rejectCode > 599)) out.push('rateLimit ' + JSON.stringify(rl));
        const ac = s.accessControl;
        if (ac) [].concat(ac.allow || [], ac.deny || []).filter((x) => !nicAddress(String(x))).forEach((x) => out.push('accessControl ' + x));
        const c = s.cors;
        if (c) {
            (c.allowHeaders || []).filter((h) => h !== '*' && (!nicHeader.test(h) || /^(cookie|host|origin|connection|referer|set-cookie|proxy-.*|sec-.*)$/i.test(h))).forEach((h) => out.push('cors header ' + h));
            (c.allowMethods || []).filter((m) => !['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'].includes(m)).forEach((m) => out.push('cors method ' + m));
            (c.allowOrigin || []).filter((o) => o !== '*' && !/^https?:\/\/[^/\s]+$/.test(o)).forEach((o) => out.push('cors origin ' + o));
        }
    }
    if (d.kind === 'VirtualServer') {
        for (const u of s.upstreams || []) {
            ['read-timeout', 'send-timeout', 'connect-timeout'].forEach((f) => { if (u[f] !== undefined && !nicTime(String(u[f]))) out.push('upstream ' + f + '=' + u[f]); });
            if (u['lb-method'] !== undefined && !nicLb(u['lb-method'])) out.push('upstream lb-method=' + u['lb-method']);
            if (u['max-conns'] !== undefined && !(u['max-conns'] >= 0)) out.push('upstream max-conns=' + u['max-conns']);
            if (u.sessionCookie && !/^[_A-Za-z0-9]+$/.test(u.sessionCookie.name)) out.push('sessionCookie.name=' + u.sessionCookie.name);
            if (u.healthCheck) ['interval', 'read-timeout'].forEach((f) => { if (u.healthCheck[f] !== undefined && !nicTime(String(u.healthCheck[f]))) out.push('healthCheck ' + f + '=' + u.healthCheck[f]); });
        }
        if (s.tls && s.tls.redirect && ![301, 302, 307, 308].includes(s.tls.redirect.code)) out.push('tls.redirect.code=' + s.tls.redirect.code);
    }
    if (d.kind === 'ConfigMap') {
        const data = d.data || {};
        ['proxy-read-timeout', 'proxy-send-timeout', 'proxy-connect-timeout', 'keepalive-timeout', 'worker-shutdown-timeout'].forEach((k) => { if (k in data && !nicTime(String(data[k]))) out.push(k + '=' + data[k]); });
        ['worker-connections', 'keepalive'].forEach((k) => { if (k in data && !/^\d+$/.test(String(data[k]))) out.push(k + '=' + data[k]); });
        if ('worker-processes' in data && !/^(\d+|auto)$/.test(String(data['worker-processes']))) out.push('worker-processes=' + data['worker-processes']);
        if ('lb-method' in data && !nicLb(data['lb-method'])) out.push('lb-method=' + data['lb-method']);
        // http-snippets reach nginx.conf unchecked: a bad time there fails the
        // reload for every resource on the controller.
        String(data['http-snippets'] || '').split('\n').forEach((l) => { const m = l.match(/^\s*(\w+_timeout)\s+(.*);$/); if (m && !nicTime(m[2])) out.push('http-snippets ' + l.trim()); });
    }
    return out;
}

module.exports = { refused, nicTime, nicLb, nicAddress, nicHeader };
