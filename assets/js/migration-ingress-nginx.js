    /* migration-ingress-nginx.js — the ingress-nginx SOURCE module for the
       migration tool. Defines window.MIGRATION_SOURCE: the community-controller
       version, the annotation mapping data, the analyzer's parseInput/buildPlan
       hooks, and the page strings/config the shared engine (migration-core.js)
       reads. Load order matters: shared.js → this file → migration-core.js.
       This file must not touch the DOM — the core owns all rendering — and its
       functions may dereference MigrationTool.* at call time only (the core
       defines it after this file has run).
       INGRESS_NGINX_VERSION below is the single source of truth for the
       community-controller side of the Version Reference banners (the NIC side
       lives in MigrationTool.NIC at the top of migration-core.js). */
    (function() {
        'use strict';
        // Bump when updating the Version Reference (see the release checklist in CLAUDE.md).
        const INGRESS_NGINX_VERSION = 'v1.15.1';
        const INGRESS_NGINX_RELEASE_URL = 'https://github.com/kubernetes/ingress-nginx/releases/tag/controller-' + INGRESS_NGINX_VERSION;

        // Thin call-time delegates to the shared core utilities — migration-core.js
        // loads after this file, so MigrationTool must only be dereferenced inside
        // function bodies, never at top level.
        function stripInlineComment(s) { return MigrationTool.util.stripInlineComment(s); }
        function sanitizeSnippetValue(value) { return MigrationTool.util.sanitizeSnippetValue(value); }
        function formatYamlKV(indent, key, value) { return MigrationTool.util.formatYamlKV(indent, key, value); }

        // --- YAML Migration Analyzer ---
        const ANNOTATION_MAPPINGS = [
            // Access Control
            { community: ["denylist-source-range", "whitelist-source-range"], nic: "Policy CRD accessControl (+ nginx.org/policies annotation for Ingress)", type: "policy", category: "Access Control", anchor: "access-control", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "Policy", crdInstall: true, templateFn: "generateAccessControlPolicy" } },
            { community: ["satisfy"], nic: "Annotation nginx.org/location-snippets (satisfy directive)", type: "annotation", category: "Access Control", anchor: "access-control", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "satisfy": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "satisfy ${value};" } } } },
            // Authentication (Basic)
            { community: ["auth-realm", "auth-secret", "auth-secret-type", "auth-type"], nic: "Annotation nginx.org/basic-auth-secret, nginx.org/basic-auth-realm or Policy CRD basicAuth", type: "policy", category: "Authentication (Basic)", anchor: "authentication-basic", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "auth-secret": { key: "nginx.org/basic-auth-secret", transform: "direct" }, "auth-realm": { key: "nginx.org/basic-auth-realm", transform: "direct" } }, crdKind: "Policy", crdInstall: true, templateFn: "generateBasicAuthPolicy" } },
            // Buffering
            { community: ["client-body-buffer-size"], nic: "nginx.org/client-body-buffer-size — or — VirtualServer CRD upstreams[].client-body-buffer-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "client-body-buffer-size": { key: "nginx.org/client-body-buffer-size", transform: "direct" } } } },
            { community: ["proxy-body-size"], nic: "nginx.org/client-max-body-size — or — VirtualServer CRD upstreams[].client-max-body-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-body-size": { key: "nginx.org/client-max-body-size", transform: "direct" } } } },
            { community: ["proxy-buffer-size"], nic: "nginx.org/proxy-buffer-size — or — VirtualServer CRD upstreams[].buffer-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-buffer-size": { key: "nginx.org/proxy-buffer-size", transform: "direct" } } } },
            { community: ["proxy-buffering"], nic: "nginx.org/proxy-buffering — or — VirtualServer CRD upstreams[].buffering", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-buffering": { key: "nginx.org/proxy-buffering", transform: "direct" } } } },
            { community: ["proxy-buffers-number"], nic: "nginx.org/proxy-buffers — or — VirtualServer CRD upstreams[].buffers", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-buffers-number": { key: "nginx.org/proxy-buffers", transform: "appendBufferSize" } } } },
            { community: ["proxy-busy-buffers-size"], nic: "nginx.org/proxy-busy-buffers-size — or — VirtualServer CRD upstreams[].busy-buffers-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-busy-buffers-size": { key: "nginx.org/proxy-busy-buffers-size", transform: "direct" } } } },
            { community: ["proxy-max-temp-file-size"], nic: "Annotation nginx.org/proxy-max-temp-file-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-max-temp-file-size": { key: "nginx.org/proxy-max-temp-file-size", transform: "direct" } } } },
            { community: ["proxy-request-buffering"], nic: "Annotation nginx.org/location-snippets (proxy_request_buffering directive)", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-request-buffering": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "proxy_request_buffering ${value};" } } } },
            // Canary / Traffic Splitting
            { community: ["canary", "canary-by-cookie", "canary-by-header", "canary-by-header-pattern", "canary-by-header-value", "canary-weight", "canary-weight-total"], nic: "VirtualServer CRD splits[], matches[]", type: "virtualserver", category: "Canary / Traffic Splitting", anchor: "canary-traffic-splitting", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true, templateFn: "generateCanaryVirtualServer" } },
            { community: ["affinity-canary-behavior"], nic: "VirtualServer CRD matches[] + upstreams[].sessionCookie", type: "virtualserver", category: "Session Affinity / Sticky Sessions", anchor: "session-affinity", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true } },
            // Configuration Snippets
            { community: ["configuration-snippet"], nic: "Annotation nginx.org/location-snippets", type: "annotation", category: "Configuration Snippets", anchor: "configuration-snippets", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "configuration-snippet": { key: "nginx.org/location-snippets", transform: "direct" } } } },
            { community: ["server-snippet"], nic: "Annotation nginx.org/server-snippets", type: "annotation", category: "Configuration Snippets", anchor: "configuration-snippets", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "server-snippet": { key: "nginx.org/server-snippets", transform: "direct" } } } },
            { community: ["stream-snippet"], nic: "GlobalConfiguration CRD + TransportServer CRD", type: "transportserver", category: "Configuration Snippets", anchor: "configuration-snippets", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "TransportServer", crdInstall: true, templateFn: "generateStreamSnippetTS" } },
            // CORS
            { community: ["cors-allow-credentials", "cors-allow-headers", "cors-allow-methods", "cors-allow-origin", "cors-expose-headers", "cors-max-age", "enable-cors"], nic: "Policy CRD cors (+ nginx.org/policies annotation) — or — Annotation snippets — or — VirtualServer CRD responseHeaders", type: "policy", category: "CORS / Header Manipulation", anchor: "cors", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "enable-cors": { key: "nginx.org/server-snippets", transform: "corsSnippet" } }, crdKind: "Policy", crdInstall: true, templateFn: "generateCORSPolicy" } },
            // Error Handling
            { community: ["custom-http-errors", "default-backend"], nic: "VirtualServer CRD errorPages[]", type: "virtualserver", category: "Error Handling", anchor: "error-handling", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true, templateFn: "generateErrorPagesVirtualServer" } },
            // Headers
            { community: ["connection-proxy-header"], nic: "Snippets — or — VirtualServer CRD requestHeaders.set", type: "annotation", category: "Headers", anchor: "headers", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "connection-proxy-header": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "proxy_set_header Connection \"${value}\";" } } } },
            { community: ["custom-headers"], nic: "VirtualServer CRD responseHeaders.add", type: "virtualserver", category: "Headers", anchor: "headers", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true, templateFn: "generateCustomHeadersVS" } },
            // proxy-hide-headers & proxy-pass-headers: F5 NGINX Ingress Controller-only annotations (nginx.org/) — no community equivalent
            { community: ["upstream-vhost", "x-forwarded-prefix"], nic: "VirtualServer CRD requestHeaders.set", type: "virtualserver", category: "Headers", anchor: "headers", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true, templateFn: "generateRequestHeadersVS" } },
            // Load Balancing
            { community: ["load-balance"], nic: "nginx.org/lb-method — or — VirtualServer CRD upstreams[].lb-method", type: "annotation", category: "Load Balancing", anchor: "load-balancing", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "load-balance": { key: "nginx.org/lb-method", transform: "lbMethod" } } } },
            { community: ["service-upstream"], nic: "nginx.org/use-cluster-ip — or — VirtualServer CRD upstreams[].use-cluster-ip", type: "annotation", category: "Load Balancing", anchor: "load-balancing", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "service-upstream": { key: "nginx.org/use-cluster-ip", transform: "direct" } } } },
            { community: ["upstream-hash-by", "upstream-hash-by-subset", "upstream-hash-by-subset-size"], nic: "nginx.org/lb-method — or — VirtualServer CRD upstreams[].lb-method", type: "virtualserver", category: "Load Balancing", anchor: "load-balancing", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "upstream-hash-by": { key: "nginx.org/lb-method", transform: "snippetWrap", template: "hash ${value} consistent" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateHashLBVirtualServer" } },
            // mTLS (Client)
            { community: ["auth-tls-error-page", "auth-tls-pass-certificate-to-upstream", "auth-tls-secret", "auth-tls-verify-client", "auth-tls-verify-depth"], nic: "Policy CRD ingressMTLS + snippets", type: "policy", category: "mTLS (Client Certificate Verification)", anchor: "mtls-client", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "Policy", crdInstall: true, templateFn: "generateIngressMTLSPolicy" } },
            { community: ["auth-tls-match-cn"], nic: "Annotation nginx.org/location-snippets", type: "annotation", category: "mTLS (Client Certificate Verification)", anchor: "mtls-client", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "auth-tls-match-cn": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "if ($ssl_client_s_dn !~ \"${value}\") { return 403; }" } } } },
            // mTLS (Backend)
            { community: ["proxy-ssl-ciphers", "proxy-ssl-name", "proxy-ssl-protocols", "proxy-ssl-secret", "proxy-ssl-server-name", "proxy-ssl-verify", "proxy-ssl-verify-depth"], nic: "Policy CRD egressMTLS", type: "policy", category: "mTLS (Backend/Egress)", anchor: "mtls-backend", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "Policy", crdInstall: true, templateFn: "generateEgressMTLSPolicy" } },
            // Logging
            { community: ["enable-access-log"], nic: "ConfigMap access-log-off", type: "configmap", category: "Logging", anchor: "logging", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { configMap: { "enable-access-log": { key: "access-log-off", transform: "booleanInvert" } } } },
            { community: ["enable-rewrite-log"], nic: "Annotation nginx.org/location-snippets (rewrite_log directive)", type: "annotation", category: "Logging", anchor: "logging", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "enable-rewrite-log": { key: "nginx.org/location-snippets", transform: "booleanOnOffSnippet", template: "rewrite_log ${value};" } } } },
            // Deprecated
            { community: ["http2-push-preload"], nic: "Not supported (HTTP/2 Server Push was removed from NGINX 1.25.1)", type: "unsupported", category: "Deprecated", anchor: "deprecated", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} },
            // server-tokens: F5 NGINX Ingress Controller-only annotation (nginx.org/server-tokens) — no community equivalent, not in YAML analyzer
            // Request Mirroring
            { community: ["mirror-host", "mirror-request-body", "mirror-target"], nic: "Annotations nginx.org/location-snippets (mirror directive) + nginx.org/server-snippets (internal /mirror location)", type: "annotation", category: "Request Mirroring", anchor: "mirroring", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "mirror-target": { key: "nginx.org/location-snippets", transform: "mirrorSnippet" } } } },
            // Proxy Settings
            { community: ["proxy-http-version"], nic: "Annotation nginx.org/location-snippets", type: "annotation", category: "Proxy Settings", anchor: "proxy-settings", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-http-version": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "proxy_http_version ${value};" } } } },
            // Route Delegation
            { community: ["server-alias"], nic: "VirtualServer CRD (one resource per hostname)", type: "virtualserver", category: "Route Delegation", anchor: "route-delegation", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true, templateFn: "generateServerAliasVS" } },
            // OpenTelemetry
            { community: ["enable-opentelemetry"], nic: "ConfigMap otel-exporter-endpoint, otel-trace-in-http, otel-service-name", type: "configmap", category: "OpenTelemetry", anchor: "opentelemetry", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { configMap: { "enable-opentelemetry": { key: "otel-trace-in-http", transform: "direct" } } } },
            { community: ["opentelemetry-trust-incoming-span"], nic: "No direct equivalent — NIC does not set otel_trace_context, so incoming trace context is not propagated by default (unlike the community default); there is no per-Ingress toggle, so this annotation can be removed during migration", type: "unsupported", category: "OpenTelemetry", anchor: "opentelemetry", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} },
            // Proxy Settings
            { community: ["proxy-next-upstream", "proxy-next-upstream-timeout", "proxy-next-upstream-tries"], nic: "Annotations nginx.org/proxy-next-upstream* — or — VirtualServer CRD upstreams[].next-upstream*", type: "annotation", category: "Proxy Settings", anchor: "proxy-settings", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "proxy-next-upstream": { key: "nginx.org/proxy-next-upstream", transform: "direct" }, "proxy-next-upstream-timeout": { key: "nginx.org/proxy-next-upstream-timeout", transform: "direct" }, "proxy-next-upstream-tries": { key: "nginx.org/proxy-next-upstream-tries", transform: "direct" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateProxyNextUpstreamVS" } },
            // Rate Limiting
            { community: ["limit-burst-multiplier", "limit-connections", "limit-rate", "limit-rate-after", "limit-rpm", "limit-rps", "limit-whitelist"], nic: "nginx.org/limit-req-* annotations — or — Policy CRD rateLimit", type: "policy", category: "Rate Limiting", anchor: "rate-limiting", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "limit-rps": { key: "nginx.org/limit-req-rate", transform: "appendRateUnit" }, "limit-burst-multiplier": { key: "nginx.org/limit-req-burst", transform: "burstMultiplier" } }, crdKind: "Policy", crdInstall: true, templateFn: "generateRateLimitPolicy" } },
            // Redirects
            { community: ["from-to-www-redirect", "permanent-redirect", "permanent-redirect-code", "temporal-redirect", "temporal-redirect-code"], nic: "VirtualServer CRD action.redirect", type: "virtualserver", category: "Redirects", anchor: "redirects", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true, templateFn: "generateRedirectVirtualServer" } },
            // Rewrites
            { community: ["app-root", "rewrite-target", "use-regex"], nic: "nginx.org/rewrite-target, nginx.org/app-root — or — VirtualServer CRD rewritePath", type: "virtualserver", category: "Rewrites", anchor: "rewrites", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "rewrite-target": { key: "nginx.org/rewrite-target", transform: "direct" }, "app-root": { key: "nginx.org/app-root", transform: "direct" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateRewriteVirtualServer" } },
            { community: ["proxy-redirect-from", "proxy-redirect-to"], nic: "Annotations nginx.org/proxy-redirect-from, nginx.org/proxy-redirect-to", type: "annotation", category: "Rewrites", anchor: "rewrites", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-redirect-from": { key: "nginx.org/proxy-redirect-from", transform: "direct" }, "proxy-redirect-to": { key: "nginx.org/proxy-redirect-to", transform: "direct" } } } },
            { community: ["proxy-cookie-domain", "proxy-cookie-path"], nic: "Annotation nginx.org/location-snippets", type: "annotation", category: "Rewrites", anchor: "rewrites", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-cookie-domain": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "proxy_cookie_domain ${value};" }, "proxy-cookie-path": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "proxy_cookie_path ${value};" } } } },
            // SSL/TLS
            { community: ["backend-protocol"], nic: "nginx.org/ssl-services or nginx.org/grpc-services — or — VirtualServer CRD upstreams[].tls.enable, upstreams[].type", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "backend-protocol": { key: "nginx.org/ssl-services", transform: "backendProtocol" } } } },
            { community: ["force-ssl-redirect"], nic: "Annotation nginx.org/redirect-to-https", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "force-ssl-redirect": { key: "nginx.org/redirect-to-https", transform: "direct" } } } },
            { community: ["ssl-ciphers"], nic: "Annotation nginx.org/ssl-ciphers", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "ssl-ciphers": { key: "nginx.org/ssl-ciphers", transform: "direct" } } } },
            { community: ["ssl-prefer-server-ciphers"], nic: "Annotation nginx.org/ssl-prefer-server-ciphers", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "ssl-prefer-server-ciphers": { key: "nginx.org/ssl-prefer-server-ciphers", transform: "direct" } } } },
            { community: ["ssl-redirect"], nic: "Annotation nginx.org/ssl-redirect (or nginx.org/redirect-to-https)", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "ssl-redirect": { key: "nginx.org/ssl-redirect", transform: "direct" } } } },
            { community: ["ssl-passthrough"], nic: "TransportServer CRD TLS_PASSTHROUGH", type: "transportserver", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "TransportServer", crdInstall: true, templateFn: "generateSSLPassthroughTransportServer" } },
            { community: ["preserve-trailing-slash"], nic: "Not needed (trailing slash preserved by default)", type: "unsupported", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} },
            // Timeouts
            { community: ["proxy-connect-timeout"], nic: "nginx.org/proxy-connect-timeout — or — VirtualServer CRD upstreams[].connect-timeout", type: "annotation", category: "Timeouts", anchor: "timeouts", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-connect-timeout": { key: "nginx.org/proxy-connect-timeout", transform: "appendTimeUnit" } } } },
            { community: ["proxy-read-timeout"], nic: "nginx.org/proxy-read-timeout — or — VirtualServer CRD upstreams[].read-timeout", type: "annotation", category: "Timeouts", anchor: "timeouts", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-read-timeout": { key: "nginx.org/proxy-read-timeout", transform: "appendTimeUnit" } } } },
            { community: ["proxy-send-timeout"], nic: "nginx.org/proxy-send-timeout — or — VirtualServer CRD upstreams[].send-timeout", type: "annotation", category: "Timeouts", anchor: "timeouts", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-send-timeout": { key: "nginx.org/proxy-send-timeout", transform: "appendTimeUnit" } } } },
            // Authentication (External): generic auth_request → externalAuth Policy (OSS, recommended).
            // Native OIDC (Plus) is documented as an alternative in the OIDC Authentication section.
            { community: ["auth-cache-duration", "auth-cache-key", "auth-method", "auth-proxy-set-headers", "auth-request-redirect", "auth-response-headers", "auth-signin", "auth-signin-redirect-param", "auth-snippet", "auth-url"], nic: "Policy CRD externalAuth (+ nginx.org/policies annotation)", type: "policy", category: "Authentication (External)", anchor: "authentication-external", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "Policy", crdInstall: true, templateFn: "generateExternalAuthPolicy" } },
            { community: ["auth-keepalive", "auth-keepalive-requests", "auth-keepalive-share-vars", "auth-keepalive-timeout"], nic: "Annotation nginx.org/location-snippets (auth_request directives)", type: "annotation", category: "Authentication (External)", anchor: "authentication-external", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "auth-keepalive": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "# auth-keepalive not directly supported; use auth_request directives" } } } },
            { community: ["auth-always-set-cookie"], nic: "Annotation nginx.org/location-snippets (auth_request_set directive)", type: "annotation", category: "Authentication (External)", anchor: "authentication-external", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "auth-always-set-cookie": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "auth_request_set $auth_cookie $upstream_http_set_cookie;\nadd_header Set-Cookie $auth_cookie;" } } } },
            { community: ["enable-global-auth"], nic: "Not applicable (F5 NGINX Ingress Controller has no global external auth)", type: "unsupported", category: "Authentication (External)", anchor: "authentication-external", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} },
            // Session Affinity (OSS + Plus)
            { community: ["affinity", "affinity-mode", "session-cookie-change-on-failure", "session-cookie-conditional-samesite-none", "session-cookie-domain", "session-cookie-expires", "session-cookie-max-age", "session-cookie-name", "session-cookie-path", "session-cookie-samesite", "session-cookie-secure"], nic: "VirtualServer CRD sessionCookie", type: "virtualserver", category: "Session Affinity / Sticky Sessions", anchor: "session-affinity", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true, templateFn: "generateSessionAffinityVS" } },
            // Plus: WAF
            // ModSecurity / WAF — no OSS replacement; Plus users can use F5 WAF for NGINX
            { community: ["enable-modsecurity", "enable-owasp-core-rules", "modsecurity-snippet", "modsecurity-transaction-id"], nic: "No direct replacement (OSS) — F5 WAF for NGINX available with Plus", type: "unsupported", category: "ModSecurity / WAF", anchor: "modsecurity", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} }
        ];

        const ANNOTATION_LOOKUP = new Map();
        ANNOTATION_MAPPINGS.forEach(function(mapping, idx) {
            mapping.community.forEach(function(name) {
                ANNOTATION_LOOKUP.set(name, idx);
            });
        });

        // Source-specific syntax warnings, appended after the core's generic checks
        // (the Kustomize / YAML-anchor / Helm-template checks live in
        // MigrationTool.util.detectGenericSyntaxWarnings).
        function detectIngressSyntaxWarnings(yamlText) {
            let warnings = [];
            // Multiple Ingress rules/hosts — example CRDs are built from the first rule only.
            if ((yamlText.match(/^\s*-?\s*host:\s*\S/gm) || []).length > 1) {
                warnings.push({
                    title: 'Multiple hosts/rules detected',
                    message: 'The analyzer builds its example resources from the first rule only. Review the generated YAML and add the remaining hosts, paths, and services manually.'
                });
            }
            // Named service ports — the analyzer uses port 80 as a placeholder for these.
            if (/\bport:\s*name:\s*\S/.test(yamlText)) {
                warnings.push({
                    title: 'Named service port detected',
                    message: 'The analyzer uses port 80 as a placeholder for named ports. Set the correct port in the generated resources.'
                });
            }
            return warnings;
        }

        function parseYamlAnnotations(yamlText) {
            let results = [];
            // Normalize CRLF/CR so line-by-line parsing never trips on a trailing \r.
            yamlText = yamlText.replace(/\r\n?/g, '\n');
            let docs = yamlText.split(/^---\s*$/m);
            docs.forEach(function(doc, docIndex) {
                let lines = doc.split('\n');
                let inAnnotations = false;
                let annotationIndent = -1;
                for (let i = 0; i < lines.length; i++) {
                    let line = lines[i];
                    let trimmed = line.trimStart();
                    if (trimmed.startsWith('#') || trimmed === '') continue;
                    let currentIndent = line.length - line.trimStart().length;
                    if (/^\s*annotations\s*:/.test(line)) {
                        let inlineMatch = line.match(/annotations\s*:\s*\{(.+)\}/);
                        if (inlineMatch) {
                            let pairRegex = /["']?([^"':,]+(?::\/\/[^"':,]*)*)["']?\s*:\s*["']?([^"',}]*(?:,[^"':},]*)*)["']?/g;
                            let pairMatch;
                            while ((pairMatch = pairRegex.exec(inlineMatch[1])) !== null) {
                                let key = pairMatch[1].trim().replace(/^["']|["']$/g, '');
                                let val = stripInlineComment(pairMatch[2]).trim().replace(/^["']|["']$/g, '');
                                if (key.startsWith('nginx.ingress.kubernetes.io/')) {
                                    results.push({ annotation: key.replace('nginx.ingress.kubernetes.io/', ''), value: val, docIndex: docIndex });
                                }
                            }
                            inAnnotations = false;
                            continue;
                        }
                        inAnnotations = true;
                        annotationIndent = currentIndent;
                        continue;
                    }
                    if (inAnnotations) {
                        if (currentIndent <= annotationIndent && trimmed !== '') {
                            inAnnotations = false;
                            annotationIndent = -1;
                            continue;
                        }
                        let kvMatch = trimmed.match(/^["']?([^"':]+)["']?\s*:\s*(.*)$/);
                        if (kvMatch) {
                            let key = kvMatch[1].trim().replace(/^["']|["']$/g, '');
                            let val = stripInlineComment(kvMatch[2]).trim().replace(/^["']|["']$/g, '');
                            // Handle pipe (|) and block scalar (>) multi-line values
                            if (/^[|>][+-]?\s*$/.test(val)) {
                                let blockLines = [];
                                let blockIndent = -1;
                                for (let j = i + 1; j < lines.length; j++) {
                                    let bLine = lines[j];
                                    if (bLine.trim() === '') {
                                        // Peek ahead: if next non-empty line has lower indent, end block
                                        let peek = j + 1;
                                        while (peek < lines.length && lines[peek].trim() === '') peek++;
                                        if (peek < lines.length && blockIndent !== -1) {
                                            let peekIndent = lines[peek].length - lines[peek].trimStart().length;
                                            if (peekIndent < blockIndent) break;
                                        }
                                        blockLines.push('');
                                        i = j;
                                        continue;
                                    }
                                    let bIndent = bLine.length - bLine.trimStart().length;
                                    if (blockIndent === -1) {
                                        // Block content must be more indented than the key line;
                                        // otherwise the block is empty and this is a sibling key.
                                        if (bIndent <= currentIndent) break;
                                        blockIndent = bIndent;
                                    }
                                    if (bIndent < blockIndent) break;
                                    blockLines.push(bLine.substring(blockIndent));
                                    i = j;
                                }
                                val = blockLines.join('\n').trim();
                            }
                            if (key.startsWith('nginx.ingress.kubernetes.io/')) {
                                results.push({ annotation: key.replace('nginx.ingress.kubernetes.io/', ''), value: val, docIndex: docIndex });
                            }
                        }
                    }
                }
            });
            return results;
        }

        // Translate a community annotation value to its NIC equivalent.
        // Returns either a string (the translated value) or an object
        // { value, note } when a non-trivial substitution was applied.
        // `found` (the entry's found annotations) enables cross-annotation
        // transforms like burstMultiplier.
        function translateValue(value, transform, template, found) {
            if (!value && value !== '0') return value;
            switch (transform) {
                case 'direct': return value;
                case 'booleanInvert': return value === 'true' ? 'false' : value === 'false' ? 'true' : value;
                case 'appendRateUnit': return /r\/[sm]$/.test(value) ? value : value + 'r/s';
                case 'appendTimeUnit': return /[smhd]$/.test(value) ? value : value + 's';
                case 'appendBufferSize': return /\s/.test(value) ? value : value + ' 8k';
                case 'snippetWrap': return template ? template.replace('${value}', sanitizeSnippetValue(value)) : value;
                case 'booleanOnOffSnippet': return template ? template.replace('${value}', value === 'true' ? 'on' : value === 'false' ? 'off' : sanitizeSnippetValue(value)) : value;
                case 'burstMultiplier': {
                    // Community semantics: burst = rate × limit-burst-multiplier
                    // (default 5); nginx.org/limit-req-burst is the absolute burst.
                    let rate = found ? parseInt(getAnnotationValue(found, 'limit-rps') || getAnnotationValue(found, 'limit-rpm') || '', 10) : NaN;
                    let mult = parseInt(value, 10);
                    if (!isNaN(rate) && !isNaN(mult)) {
                        return { value: String(rate * mult), note: 'burst = rate (' + rate + ') × multiplier (' + mult + ')' };
                    }
                    return { value: value, note: 'community burst = rate × multiplier — replace with your computed burst size' };
                }
                case 'backendProtocol': return value; // key selection handled in generateMigrationYaml
                case 'corsSnippet': return value; // handled specially in generateMigrationYaml
                case 'lbMethod': {
                    // NIC's nginx.org/lb-method does not support every value the
                    // community controller accepts. Map known unsupported values
                    // to the closest equivalent and surface a note.
                    let lbAliases = { 'ewma': 'least_conn', 'round_robin': 'round_robin' };
                    let trimmed = (value || '').trim();
                    if (lbAliases[trimmed] && lbAliases[trimmed] !== trimmed) {
                        return { value: lbAliases[trimmed], note: trimmed + ' is not supported, using ' + lbAliases[trimmed] + ' as the closest equivalent' };
                    }
                    return value;
                }
                default: return value;
            }
        }

        // Normalize a translateValue result into { value, note } for callers.
        function unwrapTranslated(result) {
            if (result && typeof result === 'object' && 'value' in result) {
                return { value: result.value, note: result.note || null };
            }
            return { value: result, note: null };
        }

        // Extract Ingress spec fields (host, service, port, path, tls, name) from YAML text
        function parseIngressSpec(yamlText) {
            let specs = [];
            yamlText = yamlText.replace(/\r\n?/g, '\n');
            let docs = yamlText.split(/^---\s*$/m);
            docs.forEach(function(doc) {
                let spec = { host: null, serviceName: null, servicePort: null, path: null, tlsSecret: null, ingressName: null };
                let lines = doc.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    let line = lines[i];
                    let trimmed = line.trim();
                    if (trimmed.startsWith('#') || trimmed === '') continue;
                    let indent = line.length - line.trimStart().length;
                    // Ingress name
                    if (/^\s{2}name:\s/.test(line) && indent <= 4 && !spec.ingressName) {
                        let m = trimmed.match(/^name:\s*["']?([^"'\s]+)["']?/);
                        if (m) spec.ingressName = m[1];
                    }
                    // Host from rules
                    if (/^\s+-?\s*host:\s/.test(line) && !spec.host) {
                        let m = trimmed.match(/^-?\s*host:\s*["']?([^"'\s]+)["']?/);
                        if (m) spec.host = m[1];
                    }
                    // Path
                    if (/^\s+-?\s*path:\s/.test(line) && !spec.path) {
                        let m = trimmed.match(/^-?\s*path:\s*["']?([^"'\s]+)["']?/);
                        if (m) spec.path = m[1];
                    }
                    // Service name (v1 style: backend.service.name)
                    if (/^\s+name:\s/.test(line) && indent >= 10 && !spec.serviceName) {
                        // Check context: previous non-empty lines should include service: or backend:
                        for (let k = i - 1; k >= Math.max(0, i - 4); k--) {
                            let prev = lines[k].trim();
                            if (/^service:/.test(prev) || /^backend:/.test(prev) || /^serviceName:/.test(prev)) {
                                let m = trimmed.match(/^name:\s*["']?([^"'\s]+)["']?/);
                                if (m) spec.serviceName = m[1];
                                break;
                            }
                        }
                    }
                    // Service name (legacy style: serviceName)
                    if (/^\s+serviceName:\s/.test(line) && !spec.serviceName) {
                        let m = trimmed.match(/^serviceName:\s*["']?([^"'\s]+)["']?/);
                        if (m) spec.serviceName = m[1];
                    }
                    // Service port number
                    if (/^\s+number:\s/.test(line) && indent >= 12 && !spec.servicePort) {
                        let m = trimmed.match(/^number:\s*["']?(\d+)["']?/);
                        if (m) spec.servicePort = m[1];
                    }
                    // Service port (legacy style: servicePort)
                    if (/^\s+servicePort:\s/.test(line) && !spec.servicePort) {
                        let m = trimmed.match(/^servicePort:\s*["']?(\w+)["']?/);
                        if (m) spec.servicePort = m[1];
                    }
                    // TLS secret
                    if (/^\s+secretName:\s/.test(line) && !spec.tlsSecret) {
                        let m = trimmed.match(/^secretName:\s*["']?([^"'\s]+)["']?/);
                        if (m) spec.tlsSecret = m[1];
                    }
                }
                specs.push(spec);
            });
            // Merge all docs into one spec (use first non-null value found)
            let merged = { host: null, serviceName: null, servicePort: null, path: null, tlsSecret: null, ingressName: null };
            specs.forEach(function(s) {
                Object.keys(merged).forEach(function(k) { if (!merged[k] && s[k]) merged[k] = s[k]; });
            });
            return merged;
        }

        function getAnnotationValue(foundAnnotations, name) {
            let found = foundAnnotations.find(function(a) { return a.annotation === name; });
            return found ? found.value : null;
        }

        // Helper: resolve spec values with fallback to TODO placeholders
        function specHost(spec) { return (spec && spec.host) || '# TODO: Set your host'; }
        function specService(spec) { return (spec && spec.serviceName) || '# TODO: Set your service'; }
        function specPort(spec) { return (spec && spec.servicePort) || '80'; }
        function specPath(spec) { return (spec && spec.path) || '/'; }

        let CRD_GENERATORS = {
            generateAccessControlPolicy: function(found) {
                let allow = getAnnotationValue(found, 'whitelist-source-range');
                let deny = getAnnotationValue(found, 'denylist-source-range');
                function buildPolicy(name, mode, cidrs) {
                    let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: ' + name, 'spec:', '  accessControl:', '    ' + mode + ':'];
                    cidrs.split(',').forEach(function(ip) { lines.push('      - ' + ip.trim()); });
                    return lines;
                }
                let lines, refNames;
                if (allow && deny) {
                    // accessControl accepts either allow or deny, never both — NIC
                    // rejects a Policy carrying both, so emit one Policy per mode.
                    lines = buildPolicy('access-control-allow', 'allow', allow).concat(['---'], buildPolicy('access-control-deny', 'deny', deny));
                    refNames = 'access-control-allow,access-control-deny';
                } else if (allow || deny) {
                    lines = buildPolicy('access-control-policy', allow ? 'allow' : 'deny', allow || deny);
                    refNames = 'access-control-policy';
                } else {
                    lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: access-control-policy', 'spec:', '  accessControl:', '    allow:', '      - # TODO: Set your allowed CIDRs'];
                    refNames = 'access-control-policy';
                }
                lines.push('', '# Reference from Ingress using:', '#   annotations:', '#     nginx.org/policies: "' + refNames + '"');
                return lines.join('\n');
            },
            generateCORSPolicy: function(found) {
                let originExplicit = getAnnotationValue(found, 'cors-allow-origin');
                let origin = originExplicit || '*';
                let methods = getAnnotationValue(found, 'cors-allow-methods') || 'GET, POST, OPTIONS';
                let headers = getAnnotationValue(found, 'cors-allow-headers') || 'Content-Type, Authorization';
                let creds = getAnnotationValue(found, 'cors-allow-credentials');
                let expose = getAnnotationValue(found, 'cors-expose-headers');
                let maxAge = getAnnotationValue(found, 'cors-max-age') || '86400';
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: cors-policy', 'spec:', '  cors:', '    allowOrigin:'];
                if (!originExplicit && creds === 'true') {
                    // NIC rejects allowOrigin "*" together with allowCredentials: true (CORS spec).
                    lines.push('      - "# TODO: set an explicit origin (\'*\' is invalid with allowCredentials: true)"');
                } else {
                    origin.split(',').forEach(function(o) { lines.push('      - "' + o.trim() + '"'); });
                }
                lines.push('    allowMethods:');
                methods.split(',').forEach(function(m) { lines.push('      - "' + m.trim() + '"'); });
                lines.push('    allowHeaders:');
                headers.split(',').forEach(function(h) { lines.push('      - "' + h.trim() + '"'); });
                if (creds === 'true') lines.push('    allowCredentials: true');
                if (expose) {
                    lines.push('    exposeHeaders:');
                    expose.split(',').forEach(function(e) { lines.push('      - "' + e.trim() + '"'); });
                }
                lines.push('    maxAge: ' + parseInt(maxAge, 10));
                lines.push('', '# Reference from Ingress using:', '#   annotations:', '#     nginx.org/policies: "cors-policy"', '', '# Or reference from VirtualServer:', '#   spec:', '#     policies:', '#       - name: cors-policy');
                return lines.join('\n');
            },
            generateBasicAuthPolicy: function(found) {
                // auth-secret is commonly "namespace/name" — the Policy takes a bare Secret name
                let secretRaw = getAnnotationValue(found, 'auth-secret');
                let secret = secretRaw ? secretRaw.replace(/^[^/]+\//, '') : '# TODO: Set your secret name';
                let realm = (getAnnotationValue(found, 'auth-realm') || 'Protected Area').replace(/"/g, '\\"');
                return ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: basic-auth-policy', 'spec:', '  basicAuth:', '    secret: ' + secret, '    realm: "' + realm + '"'].join('\n');
            },
            generateIngressMTLSPolicy: function(found) {
                let secret = getAnnotationValue(found, 'auth-tls-secret');
                let verify = getAnnotationValue(found, 'auth-tls-verify-client');
                let depth = getAnnotationValue(found, 'auth-tls-verify-depth');
                let secretVal = secret ? secret.replace(/^[^/]+\//, '') : '# TODO: Set your CA secret';
                return ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: ingress-mtls-policy', 'spec:', '  ingressMTLS:', '    clientCertSecret: ' + secretVal, '    verifyClient: "' + (verify || 'on') + '"', '    verifyDepth: ' + (depth || '1')].join('\n');
            },
            generateEgressMTLSPolicy: function(found) {
                let secret = getAnnotationValue(found, 'proxy-ssl-secret');
                let verify = getAnnotationValue(found, 'proxy-ssl-verify');
                let depth = getAnnotationValue(found, 'proxy-ssl-verify-depth');
                let secretVal = secret ? secret.replace(/^[^/]+\//, '') : '# TODO: Set your client cert secret';
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: egress-mtls-policy', 'spec:', '  egressMTLS:', '    tlsSecret: ' + secretVal, '    trustedCertSecret: # TODO: Set your CA cert secret'];
                if (verify) lines.push('    verifyServer: ' + (verify === 'on' ? 'true' : 'false'));
                if (depth) lines.push('    verifyDepth: ' + depth);
                return lines.join('\n');
            },
            generateRateLimitPolicy: function(found) {
                let rps = getAnnotationValue(found, 'limit-rps');
                let rpm = getAnnotationValue(found, 'limit-rpm');
                let rate = rps ? rps + 'r/s' : (rpm ? rpm + 'r/m' : '# TODO: Set your rate');
                // Community burst = rate × limit-burst-multiplier (default multiplier 5)
                let rateNum = parseInt(rps || rpm, 10);
                let mult = parseInt(getAnnotationValue(found, 'limit-burst-multiplier') || '5', 10);
                let burstVal = !isNaN(rateNum) ? String(rateNum * (isNaN(mult) ? 5 : mult)) : '# TODO: Set your burst (rate × multiplier)';
                return ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: rate-limit-policy', 'spec:', '  rateLimit:', '    rate: ' + rate, '    burst: ' + burstVal, '    key: ${binary_remote_addr}', '    zoneSize: 10M', '    rejectCode: 429'].join('\n');
            },
            generateCanaryVirtualServer: function(found, spec) {
                let weight = parseInt(getAnnotationValue(found, 'canary-weight') || '20', 10);
                let total = parseInt(getAnnotationValue(found, 'canary-weight-total') || '100', 10);
                let header = getAnnotationValue(found, 'canary-by-header');
                let headerValue = getAnnotationValue(found, 'canary-by-header-value');
                let headerPattern = getAnnotationValue(found, 'canary-by-header-pattern');
                let cookie = getAnnotationValue(found, 'canary-by-cookie');
                if (isNaN(weight)) weight = 20;
                if (isNaN(total) || total <= 0) total = 100;
                // Community weights are a fraction of canary-weight-total (default 100);
                // NIC split weights are integers that must sum to exactly 100.
                let canaryPct = Math.min(100, Math.max(0, Math.round((weight / total) * 100)));
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: canary-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: main', '      service: ' + specService(spec), '      port: ' + specPort(spec), '    - name: canary', '      service: # TODO: canary service', '      port: ' + specPort(spec), '  routes:', '    - path: ' + specPath(spec)];
                if (header || cookie) {
                    // Community routes to the canary when the header/cookie value is
                    // exactly "always", the custom canary-by-header-value, or matches
                    // the canary-by-header-pattern regex (NIC conditions accept PCRE
                    // via a "~" prefix). Value takes precedence over pattern upstream.
                    lines.push('      matches:');
                    if (header) {
                        let matchVal = headerValue || (headerPattern ? '~' + headerPattern : 'always');
                        matchVal = matchVal.replace(/"/g, '\\"').replace(/\\+$/, '');
                        lines.push('        - conditions:', '            - header: ' + header, '              value: "' + matchVal + '"', '          action:', '            pass: canary');
                    }
                    if (cookie) { lines.push('        - conditions:', '            - cookie: ' + cookie, '              value: "always"', '          action:', '            pass: canary'); }
                }
                let rounded = (weight / total) * 100 !== canaryPct;
                lines.push('      splits:', '        - weight: ' + (100 - canaryPct), '          action: { pass: main }', '        - weight: ' + canaryPct + (rounded ? '  # rounded from ' + weight + '/' + total : ''), '          action: { pass: canary }');
                return lines.join('\n');
            },
            generateRedirectVirtualServer: function(found, spec) {
                let permanent = getAnnotationValue(found, 'permanent-redirect');
                let temporal = getAnnotationValue(found, 'temporal-redirect');
                // Community redirects everything to the exact URL — don't append
                // ${request_uri} (add it yourself if you want path preservation).
                let url = permanent || temporal || '# TODO: Set redirect URL';
                let code = (!permanent && temporal)
                    ? (getAnnotationValue(found, 'temporal-redirect-code') || '302')
                    : (getAnnotationValue(found, 'permanent-redirect-code') || '301');
                return ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: redirect-app', 'spec:', '  host: ' + specHost(spec), '  routes:', '    - path: ' + specPath(spec), '      action:', '        redirect:', '          url: ' + url, '          code: ' + code].join('\n');
            },
            generateRewriteVirtualServer: function(found, spec) {
                let target = getAnnotationValue(found, 'rewrite-target') || '/$2';
                let path = (spec && spec.path) ? '~ ^' + spec.path : '~ ^/api(/|$)(.*)';
                return ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: rewrite-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '  routes:', '    - path: ' + path, '      action:', '        proxy:', '          upstream: backend', '          rewritePath: ' + target].join('\n');
            },
            generateErrorPagesVirtualServer: function(found, spec) {
                let codes = getAnnotationValue(found, 'custom-http-errors') || '404,500,502';
                let codeList = codes.split(',').map(function(c) { return c.trim(); });
                return ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: error-pages-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '  routes:', '    - path: ' + specPath(spec), '      action:', '        pass: backend', '      errorPages:', '        - codes: [' + codeList.join(', ') + ']', '          return:', '            code: 503', '            body: "Service Unavailable"'].join('\n');
            },
            generateSSLPassthroughTransportServer: function(found, spec) {
                return ['# tls-passthrough is a built-in listener — no GlobalConfiguration needed', 'apiVersion: k8s.nginx.org/v1', 'kind: TransportServer', 'metadata:', '  name: ssl-passthrough-app', 'spec:', '  listener:', '    name: tls-passthrough', '    protocol: TLS_PASSTHROUGH', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: 443', '  action:', '    pass: backend'].join('\n');
            },
            generateStreamSnippetTS: function(found, spec) {
                return ['apiVersion: k8s.nginx.org/v1', 'kind: TransportServer', 'metadata:', '  name: stream-app', 'spec:', '  listener:', '    name: # TODO: Define in GlobalConfiguration', '    protocol: TCP', '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '  action:', '    pass: backend'].join('\n');
            },
            generateCustomHeadersVS: function(found, spec) {
                let val = getAnnotationValue(found, 'custom-headers') || 'default/custom-headers-configmap';
                return ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: custom-headers-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '  routes:', '    - path: ' + specPath(spec), '      action:', '        proxy:', '          upstream: backend', '          responseHeaders:', '            add:', '              - name: # TODO: Add your headers', '                value: # TODO: Set values', '  # Note: Migrating from ConfigMap ref: ' + val].join('\n');
            },
            generateRequestHeadersVS: function(found, spec) {
                let vhost = getAnnotationValue(found, 'upstream-vhost');
                let prefix = getAnnotationValue(found, 'x-forwarded-prefix');
                let headers = [];
                if (vhost) headers.push('              - name: Host', '                value: "' + vhost + '"');
                if (prefix) headers.push('              - name: X-Forwarded-Prefix', '                value: "' + prefix + '"');
                if (headers.length === 0) headers.push('              - name: # TODO: Set header', '                value: # TODO: Set value');
                return ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: headers-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '  routes:', '    - path: ' + specPath(spec), '      action:', '        proxy:', '          upstream: backend', '          requestHeaders:', '            set:'].concat(headers).join('\n');
            },
            generateHashLBVirtualServer: function(found, spec) {
                let hashBy = getAnnotationValue(found, 'upstream-hash-by') || '$request_uri';
                return ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: hash-lb-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '      lb-method: "hash ' + hashBy + ' consistent"', '  routes:', '    - path: ' + specPath(spec), '      action:', '        pass: backend'].join('\n');
            },
            generateProxyNextUpstreamVS: function(found, spec) {
                let conditions = getAnnotationValue(found, 'proxy-next-upstream') || 'error timeout';
                let timeout = getAnnotationValue(found, 'proxy-next-upstream-timeout');
                let tries = getAnnotationValue(found, 'proxy-next-upstream-tries');
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: proxy-upstream-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '      next-upstream: "' + conditions + '"'];
                if (timeout) lines.push('      next-upstream-timeout: ' + (timeout.endsWith('s') ? timeout : timeout + 's'));
                if (tries) lines.push('      next-upstream-tries: ' + tries);
                lines.push('  routes:', '    - path: ' + specPath(spec), '      action:', '        pass: backend');
                return lines.join('\n');
            },
            generateServerAliasVS: function(found, spec) {
                let alias = getAnnotationValue(found, 'server-alias') || 'alias.example.com';
                return ['# Create a separate VirtualServer per host alias', 'apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: alias-app', 'spec:', '  host: ' + alias, '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '  routes:', '    - path: ' + specPath(spec), '      action:', '        pass: backend'].join('\n');
            },
            generateExternalAuthPolicy: function(found) {
                let authUrl = getAnnotationValue(found, 'auth-url');
                let signin = getAnnotationValue(found, 'auth-signin');
                let snippet = getAnnotationValue(found, 'auth-snippet');
                let serviceName = '# TODO: Set your auth service (namespace/name)';
                let authURI = '/auth';
                if (authUrl) {
                    let m = authUrl.match(/^https?:\/\/([^\/:]+)(?::\d+)?(\/[^\s]*)?$/);
                    if (m) {
                        let parts = m[1].split('.');
                        // Cluster-internal "svc.ns.svc.cluster.local" → "ns/svc"; bare host → host.
                        serviceName = (parts.length >= 2 && parts.indexOf('svc') !== -1) ? (parts[1] + '/' + parts[0]) : parts[0];
                        if (m[2]) authURI = m[2];
                    }
                }
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: external-auth-policy', 'spec:', '  externalAuth:', '    authURI: "' + authURI + '"  # auth-url (path)', '    authServiceName: "' + serviceName + '"  # auth-url (service)'];
                if (signin) {
                    // NIC authSigninURI is a RELATIVE URI (validated ^/.*$); the community
                    // auth-signin is typically a full URL — strip scheme+host, keep the path.
                    let signinPath = String(signin).replace(/^https?:\/\/[^\/]+/, '') || '/signin';
                    if (signinPath[0] !== '/') signinPath = '/' + signinPath;
                    lines.push('    authSigninURI: "' + signinPath + '"  # auth-signin (path only — NIC authSigninURI is relative, ^/.*$)');
                }
                if (snippet) {
                    lines.push('    authSnippets: |  # auth-snippet');
                    snippet.split('\n').forEach(function(l) { lines.push('      ' + l.trim()); });
                }
                lines.push('', '# Reference from Ingress (v5.5.0+):', '#   annotations:', '#     nginx.org/policies: "external-auth-policy"', '# For native OIDC (Plus), use the oidc Policy instead — see the OIDC Authentication section.');
                return lines.join('\n');
            },
            generateSessionAffinityVS: function(found, spec) {
                let name = getAnnotationValue(found, 'session-cookie-name') || 'SERVERID';
                let expires = getAnnotationValue(found, 'session-cookie-expires');
                let path = getAnnotationValue(found, 'session-cookie-path') || '/';
                let secure = getAnnotationValue(found, 'session-cookie-secure');
                let samesite = getAnnotationValue(found, 'session-cookie-samesite');
                let lines = ['apiVersion: k8s.nginx.org/v1', 'kind: VirtualServer', 'metadata:', '  name: sticky-app', 'spec:', '  host: ' + specHost(spec), '  upstreams:', '    - name: backend', '      service: ' + specService(spec), '      port: ' + specPort(spec), '      sessionCookie:', '        enable: true', '        name: ' + name];
                if (expires) {
                    let secs = parseInt(expires, 10);
                    if (secs > 0 && secs % 3600 === 0) {
                        lines.push('        expires: ' + (secs / 3600) + 'h');
                    } else {
                        lines.push('        expires: ' + secs + 's');
                    }
                }
                lines.push('        path: ' + path);
                if (secure) lines.push('        secure: ' + secure);
                lines.push('        httpOnly: true');
                if (samesite) lines.push('        samesite: ' + samesite.toLowerCase());
                lines.push('  routes:', '    - path: ' + specPath(spec), '      action:', '        pass: backend');
                return lines.join('\n');
            },
            generateWAFPolicy: function(found) {
                return ['apiVersion: k8s.nginx.org/v1', 'kind: Policy', 'metadata:', '  name: waf-policy', 'spec:', '  waf:', '    enable: true', '    apPolicy: "default/waf-policy"', '    securityLogs:', '      - enable: true', '        apLogConf: "default/log-config"', '        logDest: "syslog:server=syslog:514"'].join('\n');
            }
        };

        function generateMigrationYaml(sorted, ingressSpec, strategy) {
            ingressSpec = ingressSpec || {};
            let annotationSwaps = [];
            let configMapChanges = [];
            let crdResources = [];
            let unsupportedEntries = [];
            let infoNotes = [];

            sorted.forEach(function(entry) {
                let m = entry.mapping;
                let om = m.nicMapping;
                if (!om) return;

                // Collect unsupported annotations
                if (m.type === 'unsupported') {
                    unsupportedEntries.push(entry);
                    return;
                }

                // For dualApproach entries, only generate the path matching the chosen strategy.
                let isDual = m.dualApproach && om.annotations && om.crdKind;
                let skipAnnotations = isDual && strategy === 'crd';
                let hasCorsSnippet = om.annotations && Object.keys(om.annotations).some(function(k) { return om.annotations[k].transform === 'corsSnippet'; });
                // Annotation-first only skips the CRD when the found annotations actually
                // have an annotation path — entries whose annotations are CRD-only keep it.
                let coversFound = om.annotations && (hasCorsSnippet || entry.foundAnnotations.some(function(a) { return !!om.annotations[a.annotation]; }));
                let skipCrd = isDual && strategy === 'annotation' && coversFound;

                // Annotation swaps
                if (om.annotations && !skipAnnotations) {
                    let hasMirrorSnippet = Object.keys(om.annotations).some(function(k) { return om.annotations[k].transform === 'mirrorSnippet'; });
                    // Special handling for CORS — generate one combined snippet
                    if (hasCorsSnippet) {
                        let corsOrigin = sanitizeSnippetValue(getAnnotationValue(entry.foundAnnotations, 'cors-allow-origin') || '*');
                        let corsMethods = sanitizeSnippetValue(getAnnotationValue(entry.foundAnnotations, 'cors-allow-methods') || 'GET, POST, OPTIONS');
                        let corsHeaders = sanitizeSnippetValue(getAnnotationValue(entry.foundAnnotations, 'cors-allow-headers') || 'DNT,User-Agent,X-Requested-With,Content-Type,Authorization');
                        let corsCreds = getAnnotationValue(entry.foundAnnotations, 'cors-allow-credentials');
                        let corsMaxAge = sanitizeSnippetValue(getAnnotationValue(entry.foundAnnotations, 'cors-max-age') || '86400');
                        let corsExpose = getAnnotationValue(entry.foundAnnotations, 'cors-expose-headers');
                        let snippetLines = [];
                        snippetLines.push('add_header Access-Control-Allow-Origin "' + corsOrigin + '" always;');
                        snippetLines.push('add_header Access-Control-Allow-Methods "' + corsMethods + '" always;');
                        snippetLines.push('add_header Access-Control-Allow-Headers "' + corsHeaders + '" always;');
                        if (corsCreds === 'true') snippetLines.push('add_header Access-Control-Allow-Credentials "true" always;');
                        snippetLines.push('add_header Access-Control-Max-Age ' + corsMaxAge + ' always;');
                        if (corsExpose) snippetLines.push('add_header Access-Control-Expose-Headers "' + sanitizeSnippetValue(corsExpose) + '" always;');
                        snippetLines.push('if ($request_method = OPTIONS) { return 204; }');
                        annotationSwaps.push({ from: 'nginx.ingress.kubernetes.io/enable-cors + cors-*', fromAnnotations: entry.foundAnnotations, to: 'nginx.org/server-snippets', value: '|\\n  ' + snippetLines.join('\\n  '), originalValue: 'true (+ cors-* values)', entry: entry });
                    } else if (hasMirrorSnippet) {
                        // Mirroring needs a pair of snippets: the mirror directives on the
                        // location, plus the internal /mirror location they point at —
                        // otherwise the generated config mirrors to nowhere.
                        let mirrorTarget = getAnnotationValue(entry.foundAnnotations, 'mirror-target');
                        let mirrorHost = getAnnotationValue(entry.foundAnnotations, 'mirror-host');
                        let mirrorBody = getAnnotationValue(entry.foundAnnotations, 'mirror-request-body');
                        let locLines = ['mirror /mirror;', 'mirror_request_body ' + (mirrorBody === 'off' ? 'off' : 'on') + ';'];
                        annotationSwaps.push({ from: 'nginx.ingress.kubernetes.io/mirror-*', fromAnnotations: entry.foundAnnotations, to: 'nginx.org/location-snippets', value: '|\\n  ' + locLines.join('\\n  '), originalValue: mirrorTarget || '', entry: entry });
                        let srvLines = ['location /mirror {', '  internal;'];
                        srvLines.push(mirrorTarget ? '  proxy_pass ' + sanitizeSnippetValue(mirrorTarget) + ';' : '  proxy_pass http://TODO-mirror-target;  # set your mirror target URL');
                        if (mirrorHost) srvLines.push('  proxy_set_header Host ' + sanitizeSnippetValue(mirrorHost) + ';');
                        srvLines.push('}');
                        annotationSwaps.push({ from: 'nginx.ingress.kubernetes.io/mirror-target', fromAnnotations: [], to: 'nginx.org/server-snippets', value: '|\\n  ' + srvLines.join('\\n  '), originalValue: mirrorTarget || '', entry: entry });
                    } else {
                        // Special handling for backend-protocol — selects correct F5 NGINX Ingress Controller annotation based on value
                        let hasBackendProtocol = Object.keys(om.annotations).some(function(k) { return om.annotations[k].transform === 'backendProtocol'; });
                        if (hasBackendProtocol) {
                            entry.foundAnnotations.forEach(function(a) {
                                let spec = om.annotations[a.annotation];
                                if (spec && spec.transform === 'backendProtocol') {
                                    let upperVal = (a.value || '').toUpperCase();
                                    let svcName = specService(ingressSpec);
                                    if (upperVal === 'GRPC' || upperVal === 'GRPCS') {
                                        annotationSwaps.push({ from: 'nginx.ingress.kubernetes.io/' + a.annotation, fromAnnotations: [{ annotation: a.annotation, value: a.value }], to: 'nginx.org/grpc-services', value: svcName, originalValue: a.value, entry: entry });
                                    } else if (upperVal === 'HTTPS') {
                                        annotationSwaps.push({ from: 'nginx.ingress.kubernetes.io/' + a.annotation, fromAnnotations: [{ annotation: a.annotation, value: a.value }], to: 'nginx.org/ssl-services', value: svcName, originalValue: a.value, entry: entry });
                                    } else if (upperVal === 'HTTP') {
                                        infoNotes.push({ annotation: a.annotation, value: a.value, message: 'HTTP is the default protocol in F5 NGINX Ingress Controller. Remove this annotation — no replacement is needed.', entry: entry });
                                    } else if (upperVal === 'AUTO_HTTP' || upperVal === 'FCGI') {
                                        infoNotes.push({ annotation: a.annotation, value: a.value, message: upperVal + ' has no direct equivalent in F5 NGINX Ingress Controller. Review your backend protocol strategy before migrating.', entry: entry });
                                    }
                                } else if (spec) {
                                    let translated = unwrapTranslated(translateValue(a.value, spec.transform, spec.template, entry.foundAnnotations));
                                    annotationSwaps.push({ from: 'nginx.ingress.kubernetes.io/' + a.annotation, fromAnnotations: [{ annotation: a.annotation, value: a.value }], to: spec.key, value: translated.value, note: translated.note, originalValue: a.value, entry: entry });
                                }
                            });
                        } else {
                            entry.foundAnnotations.forEach(function(a) {
                                let spec = om.annotations[a.annotation];
                                if (spec) {
                                    let translated = unwrapTranslated(translateValue(a.value, spec.transform, spec.template, entry.foundAnnotations));
                                    annotationSwaps.push({ from: 'nginx.ingress.kubernetes.io/' + a.annotation, fromAnnotations: [{ annotation: a.annotation, value: a.value }], to: spec.key, value: translated.value, note: translated.note, originalValue: a.value, entry: entry });
                                }
                            });
                        }
                    }
                }

                // Under annotation-first, found annotations without an annotation path
                // are covered by the skipped CRD — say so instead of dropping them.
                if (skipCrd && !hasCorsSnippet) {
                    entry.foundAnnotations.forEach(function(a) {
                        if (!om.annotations[a.annotation]) {
                            infoNotes.push({ annotation: a.annotation, value: a.value, message: 'No annotation-only equivalent — this setting maps to the ' + om.crdKind + ' CRD approach. Switch the migration strategy to CRD-first to generate it.', entry: entry });
                        }
                    });
                }

                // ConfigMap changes
                if (om.configMap) {
                    entry.foundAnnotations.forEach(function(a) {
                        let spec = om.configMap[a.annotation];
                        if (spec) {
                            let translated = unwrapTranslated(translateValue(a.value, spec.transform, spec.template, entry.foundAnnotations));
                            configMapChanges.push({ from: 'nginx.ingress.kubernetes.io/' + a.annotation, to: spec.key, value: translated.value, note: translated.note, originalValue: a.value, entry: entry });
                        }
                    });
                }

                // CRD resources
                if (om.crdKind && om.templateFn && CRD_GENERATORS[om.templateFn] && !skipCrd) {
                    try {
                        let yaml = CRD_GENERATORS[om.templateFn](entry.foundAnnotations, ingressSpec);
                        crdResources.push({ kind: om.crdKind, install: om.crdInstall, yaml: yaml, entry: entry });
                    } catch (e) {
                        console.warn('CRD generator failed for ' + om.crdKind + ' (' + om.templateFn + '):', e);
                    }
                }
            });

            // Several annotations can map to the same ConfigMap key — keep the first
            // occurrence and flag conflicting values instead of emitting duplicate
            // keys in the generated ConfigMap data block.
            let seenCmKeys = {};
            configMapChanges = configMapChanges.filter(function(c) {
                let prev = seenCmKeys[c.to];
                if (!prev) { seenCmKeys[c.to] = c; return true; }
                if (c.value !== prev.value) {
                    prev.note = (prev.note ? prev.note + '; ' : '') + 'conflicting value "' + c.value + '" from ' + c.from.replace('nginx.ingress.kubernetes.io/', '') + ' ignored';
                }
                return false;
            });

            // Merge duplicate annotation keys (e.g., multiple location-snippets)
            let mergedSwaps = [];
            let snippetKeys = {};
            annotationSwaps.forEach(function(swap) {
                if (swap.to === 'nginx.org/location-snippets' || swap.to === 'nginx.org/server-snippets') {
                    if (!snippetKeys[swap.to]) {
                        snippetKeys[swap.to] = { swap: { from: swap.from, fromAnnotations: swap.fromAnnotations, to: swap.to, value: swap.value, originalValue: swap.originalValue, entry: swap.entry, mergedEntries: [swap.entry] }, fromParts: [swap.from], valueParts: [swap.value], origParts: [swap.originalValue || swap.value], allFromAnnotations: swap.fromAnnotations ? swap.fromAnnotations.slice() : [] };
                    } else {
                        snippetKeys[swap.to].fromParts.push(swap.from);
                        snippetKeys[swap.to].valueParts.push(swap.value);
                        snippetKeys[swap.to].origParts.push(swap.originalValue || swap.value);
                        snippetKeys[swap.to].swap.mergedEntries.push(swap.entry);
                        if (swap.fromAnnotations) swap.fromAnnotations.forEach(function(a) { snippetKeys[swap.to].allFromAnnotations.push(a); });
                    }
                } else {
                    mergedSwaps.push(swap);
                }
            });
            Object.keys(snippetKeys).forEach(function(key) {
                let merged = snippetKeys[key];
                merged.swap.from = merged.fromParts.join(' + ');
                merged.swap.value = '|\\n  ' + merged.valueParts.map(function(v) { return v.replace(/^\|\\n\s*/, ''); }).join('\\n  ');
                merged.swap.originalValue = merged.origParts.join(', ');
                if (merged.allFromAnnotations.length > 0) merged.swap.fromAnnotations = merged.allFromAnnotations;
                mergedSwaps.push(merged.swap);
            });

            // Post-process: when ssl-redirect or force-ssl-redirect is migrated,
            // also emit nginx.org/http-redirect-code: "308" so the migrated
            // Ingress preserves the community controller's 308 default
            // (which preserves the original request method and body — NIC
            // defaults to 301, which clients may downgrade to GET).
            let redirectSwap = mergedSwaps.find(function(s) {
                return s.to === 'nginx.org/ssl-redirect' || s.to === 'nginx.org/redirect-to-https';
            });
            let alreadyHasCode = mergedSwaps.some(function(s) { return s.to === 'nginx.org/http-redirect-code'; });
            if (redirectSwap && !alreadyHasCode) {
                mergedSwaps.push({
                    from: 'ssl-redirect (community 308 default)',
                    fromAnnotations: [],
                    to: 'nginx.org/http-redirect-code',
                    value: '308',
                    originalValue: '308',
                    note: 'matches community 308 default; preserves request method and body',
                    entry: redirectSwap.entry,
                    isSynthetic: true
                });
            }

            return { annotationSwaps: mergedSwaps, configMapChanges: configMapChanges, crdResources: crdResources, unsupportedEntries: unsupportedEntries, infoNotes: infoNotes };
        }

        // --- Analyzer source hooks ---
        // parseInput/buildPlan implement the core's analyzer contract: parseInput
        // turns raw YAML into findings + context, buildPlan turns them into a
        // MigrationPlan (pure data — migration-core.js owns all rendering).

        function parseInput(yamlText) {
            let findings = parseYamlAnnotations(yamlText);
            return {
                findings: findings,
                context: parseIngressSpec(yamlText),
                warnings: detectIngressSyntaxWarnings(yamlText),
                foundCount: findings.length
            };
        }

        function buildPlan(parsed, strategy) {
            let annotations = parsed.findings;
            let ingressSpec = parsed.context;
            let totalAnnotations = parsed.foundCount;
            let warnings = [];

            let matchedMappings = new Map();
            let unrecognized = [];
            let dupConflicts = [];
            annotations.forEach(function(ann) {
                let idx = ANNOTATION_LOOKUP.get(ann.annotation);
                if (idx !== undefined) {
                    if (!matchedMappings.has(idx)) {
                        matchedMappings.set(idx, { mapping: ANNOTATION_MAPPINGS[idx], foundAnnotations: [] });
                    }
                    let entry = matchedMappings.get(idx);
                    let existing = entry.foundAnnotations.find(function(a) { return a.annotation === ann.annotation; });
                    if (!existing) {
                        entry.foundAnnotations.push({ annotation: ann.annotation, value: ann.value });
                    } else if (existing.value !== ann.value && dupConflicts.indexOf(ann.annotation) === -1) {
                        // Same annotation with a different value in another document —
                        // results are built from the first occurrence; warn below.
                        dupConflicts.push(ann.annotation);
                    }
                } else {
                    if (!unrecognized.some(function(u) { return u.annotation === ann.annotation; })) {
                        unrecognized.push(ann);
                    }
                }
            });
            if (dupConflicts.length > 0) {
                warnings.push({
                    title: 'Duplicate annotations with different values',
                    message: 'These annotations appear more than once (e.g. across YAML documents) with different values — results use the first occurrence: ' + dupConflicts.join(', ') + '.'
                });
            }
            let typeOrder = { policy: 0, virtualserver: 1, virtualserverroute: 2, transportserver: 3, globalconfiguration: 4, annotation: 5, configmap: 6, unsupported: 7 };
            let sorted = Array.from(matchedMappings.values()).sort(function(a, b) {
                let ta = typeOrder[a.mapping.type] !== undefined ? typeOrder[a.mapping.type] : 99;
                let tb = typeOrder[b.mapping.type] !== undefined ? typeOrder[b.mapping.type] : 99;
                if (ta !== tb) return ta - tb;
                return a.mapping.category.localeCompare(b.mapping.category);
            });
            let migration = generateMigrationYaml(sorted, ingressSpec, strategy);

            // Summary pills
            let pills = [];
            pills.push({ cls: 'found', text: totalAnnotations + ' annotation' + (totalAnnotations !== 1 ? 's' : '') + ' found', scrollTo: null });
            pills.push({ cls: 'paths', text: sorted.length + ' migration path' + (sorted.length !== 1 ? 's' : ''), scrollTo: migration.annotationSwaps.length > 0 ? 'analyzer-step-1' : null });
            if (migration.crdResources.length > 0) pills.push({ cls: 'crds', text: migration.crdResources.length + ' require CRDs', scrollTo: 'analyzer-step-3' });
            if (unrecognized.length > 0) pills.push({ cls: 'unrecognized', text: unrecognized.length + ' unrecognized', scrollTo: 'analyzer-unrecognized' });

            // Screen-reader announcement mirrored into the live region by the core
            let liveText = totalAnnotations + ' annotation' + (totalAnnotations !== 1 ? 's' : '') + ' found, ' + sorted.length + ' migration path' + (sorted.length !== 1 ? 's' : '');
            if (migration.crdResources.length > 0) liveText += ', ' + migration.crdResources.length + ' require CRDs';
            if (unrecognized.length > 0) liveText += ', ' + unrecognized.length + ' unrecognized';

            // Success banner
            let stepCount = (migration.annotationSwaps.length > 0 ? 1 : 0) + (migration.configMapChanges.length > 0 ? 1 : 0) + (migration.crdResources.length > 0 ? 1 : 0);
            let banner = {
                strongText: totalAnnotations + ' annotations analyzed',
                restText: ', ' + sorted.length + ' migration paths across ' + stepCount + ' step' + (stepCount !== 1 ? 's' : '') + '.',
                complexity: migration.crdResources.length > 0 ? 'advanced' : migration.configMapChanges.length > 0 ? 'moderate' : 'simple'
            };

            let steps = [];

            // Step: Annotation Swaps
            if (migration.annotationSwaps.length > 0) {
                let oldLines = ['annotations:'];
                let newLines = ['annotations:'];
                let seenEntries = new Map();
                // Sort by category for grouped output
                let swapsByCategory = {};
                migration.annotationSwaps.forEach(function(swap) {
                    let cat = swap.entry.mapping.category;
                    if (!swapsByCategory[cat]) swapsByCategory[cat] = [];
                    swapsByCategory[cat].push(swap);
                });
                let categoryKeys = Object.keys(swapsByCategory).sort();
                let multiCategory = categoryKeys.length > 1;
                categoryKeys.forEach(function(cat) {
                    if (multiCategory) {
                        oldLines.push('  # ' + cat);
                        newLines.push('  # ' + cat);
                    }
                    swapsByCategory[cat].forEach(function(swap) {
                        if (swap.fromAnnotations) {
                            swap.fromAnnotations.forEach(function(a) {
                                oldLines.push(formatYamlKV('  ', 'nginx.ingress.kubernetes.io/' + a.annotation, a.value != null ? a.value : ''));
                            });
                        } else {
                            oldLines.push(formatYamlKV('  ', swap.from, swap.originalValue || swap.value));
                        }
                        // New line: NIC annotation + comment showing community source
                        // and any substitution note (e.g., "ewma is not supported, using least_conn").
                        let shortName = swap.from.replace(/nginx\.ingress\.kubernetes\.io\//g, '');
                        let commentText = shortName + (swap.note ? ' — ' + swap.note : '');
                        let newLine = formatYamlKV('  ', swap.to, swap.value);
                        if (newLine.indexOf(': |\n') !== -1) {
                            newLine = newLine.replace(': |', ': |  # ' + commentText);
                        } else {
                            newLine += '  # ' + commentText;
                        }
                        newLines.push(newLine);
                        let entriesToTrack = swap.mergedEntries || [swap.entry];
                        entriesToTrack.forEach(function(e) { if (!seenEntries.has(e)) seenEntries.set(e, e); });
                    });
                });

                let blocks = [{
                    type: 'comparison',
                    old: { title: 'Kubernetes Ingress NGINX (Ingress-NGINX) ', badge: 'current', yaml: oldLines.join('\n') },
                    new: { title: 'F5 NGINX Ingress Controller ', badge: 'migrated', yaml: newLines.join('\n') }
                }];

                // Dual-approach note
                let dualEntries = Array.from(seenEntries.values()).filter(function(e) { return e.mapping.dualApproach; });
                if (dualEntries.length > 0 && migration.crdResources.length > 0) {
                    let crdStepNum = 1 + (migration.configMapChanges.length > 0 ? 2 : 1);
                    blocks.push({ type: 'dual-note', text: 'Some annotations above also have a CRD-based approach shown in Step ' + crdStepNum + ' below.' });
                }

                steps.push({
                    id: 'analyzer-step-1',
                    title: 'Swap Annotations',
                    countText: migration.annotationSwaps.length + ' annotation' + (migration.annotationSwaps.length !== 1 ? 's' : ''),
                    countCls: '',
                    desc: 'Replace community annotations with their F5 NGINX Ingress Controller equivalents. Copy this annotations block into your Ingress metadata.',
                    blocks: blocks
                });
            }

            // Step: ConfigMap Changes
            if (migration.configMapChanges.length > 0) {
                let cmOldLines = ['annotations:'];
                let cmLines = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: nginx-config', 'data:'];
                migration.configMapChanges.forEach(function(change) {
                    cmOldLines.push(formatYamlKV('  ', change.from, change.originalValue || change.value));
                    let cmShortName = change.from.replace(/nginx\.ingress\.kubernetes\.io\//g, '');
                    let cmComment = cmShortName + (change.note ? ' — ' + change.note : '');
                    cmLines.push(formatYamlKV('  ', change.to, change.value) + '  # ' + cmComment);
                });

                steps.push({
                    id: 'analyzer-step-2',
                    title: 'ConfigMap Changes',
                    countText: migration.configMapChanges.length + ' entr' + (migration.configMapChanges.length !== 1 ? 'ies' : 'y'),
                    countCls: 'configmap',
                    desc: 'These settings are configured via the NGINX ConfigMap instead of annotations. Update your nginx-config ConfigMap with these entries.',
                    blocks: [{
                        type: 'comparison',
                        old: { title: 'Kubernetes Ingress NGINX (Ingress-NGINX) (current)', badge: null, yaml: cmOldLines.join('\n') },
                        new: { title: 'F5 NGINX Ingress Controller (migrated)', badge: null, yaml: cmLines.join('\n') }
                    }]
                });
            }

            // Step: CRD Resources
            if (migration.crdResources.length > 0) {
                let blocks = [];

                // Group by CRD kind
                let crdGroups = {};
                migration.crdResources.forEach(function(res) {
                    if (!crdGroups[res.kind]) crdGroups[res.kind] = [];
                    crdGroups[res.kind].push(res);
                });

                // Link to Installing CRDs section instead of showing inline command
                let hasCrdInstall = Object.keys(crdGroups).some(function(kind) {
                    return crdGroups[kind].some(function(res) { return res.install; });
                });
                if (hasCrdInstall) blocks.push({ type: 'crd-install-note' });

                Object.keys(crdGroups).forEach(function(kind) {
                    let group = crdGroups[kind];
                    let items = group.map(function(res) {
                        // Side-by-side: community annotations (left) → CRD resource (right)
                        let crdOldYaml = ['annotations:'];
                        res.entry.foundAnnotations.forEach(function(a) {
                            let key = 'nginx.ingress.kubernetes.io/' + a.annotation;
                            let val = a.value != null ? a.value : '';
                            let line;
                            if (val === '' || val === 'true' || val === 'false') {
                                line = '  ' + key + ': "' + val + '"';
                            } else if (/[:{}\[\],&*#?|<>=!%@`]/.test(val) || /^\s|\s$/.test(val)) {
                                line = '  ' + key + ': "' + val.replace(/"/g, '\\"') + '"';
                            } else {
                                line = '  ' + key + ': ' + val;
                            }
                            crdOldYaml.push(line);
                        });
                        return {
                            category: res.entry.mapping.category,
                            plusRequired: !!res.entry.mapping.plusRequired,
                            dualSuffix: res.entry.mapping.dualApproach ? ' — CRD Approach' : null,
                            old: { title: 'Kubernetes Ingress NGINX (Ingress-NGINX) (current)', badge: null, yaml: crdOldYaml.join('\n') },
                            new: { title: 'F5 NGINX Ingress Controller (migrated)', badge: null, yaml: MigrationTool.util.annotateYamlWithSources(res.yaml, res.entry.foundAnnotations), collapsible: true }
                        };
                    });
                    blocks.push({ type: 'crd-group', kind: kind, countText: group.length + ' resource' + (group.length !== 1 ? 's' : ''), items: items });
                });

                steps.push({
                    id: 'analyzer-step-3',
                    title: 'CRD Resources',
                    countText: migration.crdResources.length + ' resource' + (migration.crdResources.length !== 1 ? 's' : ''),
                    countCls: 'crd',
                    desc: 'These features require Custom Resource Definitions. Install the CRDs first, then apply the generated resources.',
                    blocks: blocks
                });
            }

            // Informational notes (recognized values that don't need a swap or have no equivalent)
            let infoNotes = migration.infoNotes.map(function(note) {
                return { code: 'nginx.ingress.kubernetes.io/' + note.annotation + ': ' + note.value, message: note.message };
            });

            // Unsupported annotations (recognized but no migration path)
            let unsupported = null;
            if (migration.unsupportedEntries.length > 0) {
                let unsupCount = 0;
                migration.unsupportedEntries.forEach(function(e) { unsupCount += e.foundAnnotations.length; });
                unsupported = {
                    title: 'Unsupported Annotations',
                    countText: unsupCount + ' annotation' + (unsupCount !== 1 ? 's' : ''),
                    desc: 'These annotations are recognized but have no direct equivalent in the F5 NGINX Ingress Controller. Review each one and take the recommended action.',
                    cards: migration.unsupportedEntries.map(function(entry) {
                        return {
                            title: entry.mapping.category,
                            code: entry.foundAnnotations.map(function(a) { return a.annotation; }).join(', '),
                            desc: entry.mapping.nic,
                            anchor: entry.mapping.anchor || null,
                            sidebarSection: entry.mapping.section === 'plus' ? 'plus-mappings' : 'mappings'
                        };
                    })
                };
            }

            // Unrecognized
            let unrecognizedSection = null;
            if (unrecognized.length > 0) {
                unrecognizedSection = {
                    title: 'Unrecognized Annotations',
                    desc: 'These annotations were not found in the migration database. They may be custom, deprecated, or not yet mapped.',
                    items: unrecognized.map(function(u) {
                        let key = 'nginx.ingress.kubernetes.io/' + u.annotation;
                        let val = u.value != null ? u.value : '';
                        return { yaml: 'annotations:\n  ' + key + ': ' + (val === '' || val === 'true' || val === 'false' ? '"' + val + '"' : val) };
                    })
                };
            }

            // Export actions (Copy All + Download)
            let exportData = null;
            if (migration.annotationSwaps.length > 0 || migration.configMapChanges.length > 0 || migration.crdResources.length > 0) {
                let allYamlParts = [];
                if (migration.annotationSwaps.length > 0) {
                    let swapLines = ['# Step 1: Annotation Swaps', 'annotations:'];
                    let copySwapsByCat = {};
                    migration.annotationSwaps.forEach(function(s) {
                        let cat = s.entry.mapping.category;
                        if (!copySwapsByCat[cat]) copySwapsByCat[cat] = [];
                        copySwapsByCat[cat].push(s);
                    });
                    let copyCatKeys = Object.keys(copySwapsByCat).sort();
                    copyCatKeys.forEach(function(cat) {
                        if (copyCatKeys.length > 1) swapLines.push('  # ' + cat);
                        copySwapsByCat[cat].forEach(function(s) { swapLines.push(formatYamlKV('  ', s.to, s.value)); });
                    });
                    allYamlParts.push(swapLines.join('\n'));
                }
                if (migration.configMapChanges.length > 0) {
                    let cmParts = ['# Step 2: ConfigMap Changes', 'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: nginx-config', 'data:'];
                    migration.configMapChanges.forEach(function(c) { cmParts.push(formatYamlKV('  ', c.to, c.value)); });
                    allYamlParts.push(cmParts.join('\n'));
                }
                if (migration.crdResources.length > 0) {
                    migration.crdResources.forEach(function(r) {
                        allYamlParts.push('# Step 3: ' + r.entry.mapping.category + ' (' + r.kind + ')\n' + r.yaml);
                    });
                }
                exportData = { parts: allYamlParts };
            }

            // What's Next? section
            let nextItems = null;
            if (sorted.length > 0) {
                nextItems = [
                    { text: 'Review the full Migration Checklist', anchor: '#checklist' },
                    { text: 'Browse all OSS annotation mappings', anchor: '#mappings' }
                ];
                if (migration.crdResources.length > 0) nextItems.push({ text: 'Install the required CRDs', anchor: '#installation' });
                nextItems.push({ text: 'Check the F5 NGINX Ingress Controller docs', href: 'https://docs.nginx.com/nginx-ingress-controller/', external: true });
            }

            return {
                pills: pills,
                liveText: liveText,
                banner: banner,
                warnings: warnings,
                steps: steps,
                infoNotes: infoNotes,
                unsupported: unsupported,
                unrecognized: unrecognizedSection,
                export: exportData,
                nextItems: nextItems
            };
        }

        // Sample YAML presets
        let SAMPLE_PRESETS = {
            simple:
'apiVersion: networking.k8s.io/v1\n' +
'kind: Ingress\n' +
'metadata:\n' +
'  name: simple-app\n' +
'  annotations:\n' +
'    nginx.ingress.kubernetes.io/ssl-redirect: "true"\n' +
'    nginx.ingress.kubernetes.io/proxy-body-size: "10m"\n' +
'    nginx.ingress.kubernetes.io/proxy-connect-timeout: "30"\n' +
'    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"\n' +
'    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"\n' +
'spec:\n' +
'  ingressClassName: nginx\n' +
'  tls:\n' +
'    - hosts:\n' +
'        - app.example.com\n' +
'      secretName: app-tls\n' +
'  rules:\n' +
'    - host: app.example.com\n' +
'      http:\n' +
'        paths:\n' +
'          - path: /\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: app-service\n' +
'                port:\n' +
'                  number: 80',
            moderate:
'apiVersion: networking.k8s.io/v1\n' +
'kind: Ingress\n' +
'metadata:\n' +
'  name: production-app\n' +
'  annotations:\n' +
'    nginx.ingress.kubernetes.io/ssl-redirect: "true"\n' +
'    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"\n' +
'    nginx.ingress.kubernetes.io/proxy-body-size: "50m"\n' +
'    nginx.ingress.kubernetes.io/proxy-buffer-size: "8k"\n' +
'    nginx.ingress.kubernetes.io/proxy-buffering: "on"\n' +
'    nginx.ingress.kubernetes.io/proxy-connect-timeout: "30"\n' +
'    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"\n' +
'    nginx.ingress.kubernetes.io/proxy-send-timeout: "120"\n' +
'    nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"\n' +
'    nginx.ingress.kubernetes.io/load-balance: "ewma"\n' +
'    nginx.ingress.kubernetes.io/enable-access-log: "false"\n' +
'    nginx.ingress.kubernetes.io/enable-opentelemetry: "true"\n' +
'spec:\n' +
'  ingressClassName: nginx\n' +
'  tls:\n' +
'    - hosts:\n' +
'        - app.example.com\n' +
'      secretName: app-tls\n' +
'  rules:\n' +
'    - host: app.example.com\n' +
'      http:\n' +
'        paths:\n' +
'          - path: /\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: api-service\n' +
'                port:\n' +
'                  number: 443',
            advanced:
'apiVersion: networking.k8s.io/v1\n' +
'kind: Ingress\n' +
'metadata:\n' +
'  name: enterprise-app\n' +
'  annotations:\n' +
'    # SSL and security\n' +
'    nginx.ingress.kubernetes.io/ssl-redirect: "true"\n' +
'    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"\n' +
'    nginx.ingress.kubernetes.io/auth-tls-verify-client: "on"\n' +
'    nginx.ingress.kubernetes.io/auth-tls-secret: "default/ca-secret"\n' +
'    nginx.ingress.kubernetes.io/auth-tls-verify-depth: "2"\n' +
'    # Session affinity\n' +
'    nginx.ingress.kubernetes.io/affinity: "cookie"\n' +
'    nginx.ingress.kubernetes.io/session-cookie-name: "SERVERID"\n' +
'    nginx.ingress.kubernetes.io/session-cookie-expires: "172800"\n' +
'    nginx.ingress.kubernetes.io/session-cookie-max-age: "172800"\n' +
'    nginx.ingress.kubernetes.io/session-cookie-path: "/"\n' +
'    # WAF/ModSecurity (Plus)\n' +
'    nginx.ingress.kubernetes.io/enable-modsecurity: "true"\n' +
'    nginx.ingress.kubernetes.io/modsecurity-snippet: |\n' +
'      SecRuleEngine On\n' +
'      SecRule ARGS "@contains <script>" "id:1,deny,status:403"\n' +
'    # Rate limiting\n' +
'    nginx.ingress.kubernetes.io/limit-rps: "100"\n' +
'    nginx.ingress.kubernetes.io/limit-connections: "50"\n' +
'    # Proxy settings\n' +
'    nginx.ingress.kubernetes.io/proxy-body-size: "100m"\n' +
'    nginx.ingress.kubernetes.io/proxy-connect-timeout: "60"\n' +
'    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"\n' +
'    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"\n' +
'    # CORS\n' +
'    nginx.ingress.kubernetes.io/enable-cors: "true"\n' +
'    nginx.ingress.kubernetes.io/cors-allow-origin: "*"\n' +
'    nginx.ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT, DELETE, OPTIONS"\n' +
'    nginx.ingress.kubernetes.io/cors-allow-headers: "Authorization, Content-Type, X-Request-ID"\n' +
'    # ConfigMap settings\n' +
'    nginx.ingress.kubernetes.io/enable-access-log: "true"\n' +
'    nginx.ingress.kubernetes.io/enable-opentelemetry: "true"\n' +
'spec:\n' +
'  ingressClassName: nginx\n' +
'  tls:\n' +
'    - hosts:\n' +
'        - secure.example.com\n' +
'      secretName: enterprise-tls\n' +
'  rules:\n' +
'    - host: secure.example.com\n' +
'      http:\n' +
'        paths:\n' +
'          - path: /\n' +
'            pathType: Prefix\n' +
'            backend:\n' +
'              service:\n' +
'                name: enterprise-service\n' +
'                port:\n' +
'                  number: 443'
        };

        // --- Source config consumed by migration-core.js ---
        window.MIGRATION_SOURCE = {
            id: 'ingress-nginx',
            strings: {
                analyzeEmpty: { title: 'No input.', message: 'Paste a Kubernetes Ingress YAML manifest to analyze.' },
                noFindings: { title: 'No community NGINX annotations found.', message: 'Make sure your YAML contains annotations with the nginx.ingress.kubernetes.io/ prefix.' },
                emptyStateLead: 'Paste your Ingress YAML above and click Analyze',
                emptyStateHint: 'Drag & drop a .yaml file, or try "Load Sample" for an example',
                pageNames: { 'getting-started': 'Getting Started', analyzer: 'Config Analyzer', reference: 'Reference Guide' }
            },
            versionBindings: [
                { attr: 'data-ingress-nginx-version', text: INGRESS_NGINX_VERSION },
                { attr: 'data-ingress-nginx-release-link', href: INGRESS_NGINX_RELEASE_URL }
            ],
            inputStatus: { pattern: /nginx\.ingress\.kubernetes\.io\//g, noun: 'annotation' },
            reference: {
                sections: [
                    { id: 'mappings', filterSource: 'oss', search: 'searchInput', category: 'categoryFilter', count: 'searchCount' },
                    { id: 'plus-mappings', filterSource: 'plus', search: 'searchInputPlus', category: 'categoryFilterPlus', count: 'searchCountPlus' },
                    { id: 'configmap-mappings', filterSource: 'configmap', search: 'searchInputConfigMap', category: 'categoryFilterConfigMap', count: 'searchCountConfigMap' }
                ],
                sectionPageMap: {
                    overview: 'getting-started', 'why-migrate': 'getting-started', features: 'getting-started', installation: 'getting-started', checklist: 'getting-started', 'phased-migration': 'getting-started', resources: 'getting-started',
                    differences: 'reference', 'mappings': 'reference', 'plus-mappings': 'reference', 'configmap-mappings': 'reference'
                },
                defaultPage: 'getting-started',
                fallbackPage: 'reference'
            },
            // Exact keys shipped before the core/source split — do not rename,
            // or returning visitors lose their saved checklist/banner state.
            storage: { checklist: 'migrationChecklist', eolCollapsed: 'eolWarningCollapsed' },
            eolCompact: {
                strongText: 'ingress-nginx has reached end of maintenance',
                restText: ' — this tool migrates you to the F5 NGINX Ingress Controller. '
            },
            analyzer: {
                strategies: {
                    initial: 'crd',
                    descriptions: {
                        annotation: 'Swap annotations where possible, use CRDs only when needed',
                        crd: 'Prefer Policy CRDs and VirtualServer, fall back to annotations when no CRD path exists'
                    }
                },
                samplePresets: SAMPLE_PRESETS,
                defaultPreset: 'moderate',
                parseInput: parseInput,
                buildPlan: buildPlan
            },
            export: {
                filename: 'nginx-ingress-migration.yaml',
                header: '# NGINX Ingress Migration Tool — Generated Output\n# https://kubernetes.nginx.org/ingress-nginx-migration.html'
            }
        };
    })();
