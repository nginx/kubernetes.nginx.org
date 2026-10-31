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
        // Bump when updating the Version Reference (see the release-update skill).
        const INGRESS_NGINX_VERSION = 'v1.15.1';
        const INGRESS_NGINX_RELEASE_URL = 'https://github.com/kubernetes/ingress-nginx/releases/tag/controller-' + INGRESS_NGINX_VERSION;

        // Thin call-time delegates to the shared core utilities — migration-core.js
        // loads after this file, so MigrationTool must only be dereferenced inside
        // function bodies, never at top level.
        function splitDocuments(yamlText) { return MigrationTool.util.splitDocuments(yamlText); }
        function stripInlineComment(s) { return MigrationTool.util.stripInlineComment(s); }
        function sanitizeSnippetValue(value) { return MigrationTool.util.sanitizeSnippetValue(value); }
        function formatYamlKV(indent, key, value) { return MigrationTool.util.formatYamlKV(indent, key, value); }

        // --- YAML Migration Analyzer ---
        const ANNOTATION_MAPPINGS = [
            // Access Control
            { community: ["denylist-source-range", "whitelist-source-range"], nic: "Policy CRD accessControl (+ nginx.org/policies annotation for Ingress)", type: "policy", category: "Access control", anchor: "access-control", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "Policy", crdInstall: true, templateFn: "generateAccessControlPolicy" } },
            { community: ["satisfy"], nic: "Annotation nginx.org/location-snippets (satisfy directive)", type: "annotation", category: "Access control", anchor: "access-control", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "satisfy": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "satisfy ${value};" } } } },
            // Authentication (Basic)
            { community: ["auth-realm", "auth-secret", "auth-secret-type", "auth-type"], nic: "Annotation nginx.org/basic-auth-secret, nginx.org/basic-auth-realm or Policy CRD basicAuth", type: "policy", category: "Authentication (basic)", anchor: "authentication-basic", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "auth-secret": { key: "nginx.org/basic-auth-secret", transform: "direct" }, "auth-realm": { key: "nginx.org/basic-auth-realm", transform: "direct" } }, crdKind: "Policy", crdInstall: true, templateFn: "generateBasicAuthPolicy" } },
            // Buffering
            { community: ["client-body-buffer-size"], nic: "nginx.org/client-body-buffer-size — or — VirtualServer CRD upstreams[].client-body-buffer-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "client-body-buffer-size": { key: "nginx.org/client-body-buffer-size", transform: "nicSize", vsField: "client-body-buffer-size" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            { community: ["proxy-body-size"], nic: "nginx.org/client-max-body-size — or — VirtualServer CRD upstreams[].client-max-body-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "proxy-body-size": { key: "nginx.org/client-max-body-size", transform: "nicOffset", vsField: "client-max-body-size" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            { community: ["proxy-buffer-size"], nic: "nginx.org/proxy-buffer-size — or — VirtualServer CRD upstreams[].buffer-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "proxy-buffer-size": { key: "nginx.org/proxy-buffer-size", transform: "nicSize", vsField: "buffer-size" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            { community: ["proxy-buffering"], nic: "nginx.org/proxy-buffering — or — VirtualServer CRD upstreams[].buffering", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "proxy-buffering": { key: "nginx.org/proxy-buffering", transform: "onOffBool", vsField: "buffering" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            { community: ["proxy-buffers-number"], nic: "nginx.org/proxy-buffers — or — VirtualServer CRD upstreams[].buffers", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "proxy-buffers-number": { key: "nginx.org/proxy-buffers", transform: "appendBufferSize", vsField: "buffers" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            { community: ["proxy-busy-buffers-size"], nic: "nginx.org/proxy-busy-buffers-size — or — VirtualServer CRD upstreams[].busy-buffers-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "proxy-busy-buffers-size": { key: "nginx.org/proxy-busy-buffers-size", transform: "nicSize", vsField: "busy-buffers-size" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            { community: ["proxy-max-temp-file-size"], nic: "Annotation nginx.org/proxy-max-temp-file-size", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-max-temp-file-size": { key: "nginx.org/proxy-max-temp-file-size", transform: "direct" } } } },
            { community: ["proxy-request-buffering"], nic: "Annotation nginx.org/location-snippets (proxy_request_buffering directive)", type: "annotation", category: "Buffering", anchor: "buffering", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "proxy-request-buffering": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "proxy_request_buffering ${value};" } } } },
            // Canary / Traffic Splitting
            { community: ["canary", "canary-by-cookie", "canary-by-header", "canary-by-header-pattern", "canary-by-header-value", "canary-weight", "canary-weight-total"], nic: "VirtualServer CRD splits[], matches[]", type: "virtualserver", category: "Canary / traffic splitting", anchor: "canary-traffic-splitting", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true, templateFn: "generateCanaryVirtualServer" } },
            { community: ["affinity-canary-behavior"], nic: "VirtualServer CRD matches[] + upstreams[].sessionCookie", type: "virtualserver", category: "Session affinity / sticky sessions", anchor: "session-affinity", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true, templateFn: "generateCanaryAffinityNote" } },
            // Configuration Snippets
            { community: ["configuration-snippet"], nic: "Annotation nginx.org/location-snippets", type: "annotation", category: "Configuration snippets", anchor: "configuration-snippets", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "configuration-snippet": { key: "nginx.org/location-snippets", transform: "direct" } } } },
            { community: ["server-snippet"], nic: "Annotation nginx.org/server-snippets", type: "annotation", category: "Configuration snippets", anchor: "configuration-snippets", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "server-snippet": { key: "nginx.org/server-snippets", transform: "direct" } } } },
            { community: ["stream-snippet"], nic: "GlobalConfiguration CRD + TransportServer CRD", type: "transportserver", category: "Configuration snippets", anchor: "configuration-snippets", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "TransportServer", crdInstall: true, templateFn: "generateStreamSnippetTS" } },
            // CORS
            { community: ["cors-allow-credentials", "cors-allow-headers", "cors-allow-methods", "cors-allow-origin", "cors-expose-headers", "cors-max-age", "enable-cors"], nic: "Policy CRD cors (+ nginx.org/policies annotation) — or — Annotation snippets — or — VirtualServer CRD responseHeaders", type: "policy", category: "CORS / header manipulation", anchor: "cors", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "enable-cors": { key: "nginx.org/server-snippets", transform: "corsSnippet" } }, crdKind: "Policy", crdInstall: true, templateFn: "generateCORSPolicy" } },
            // Error Handling
            { community: ["custom-http-errors", "default-backend"], nic: "nginx.org/custom-http-errors + Ingress spec.defaultBackend — or — VirtualServer CRD errorPages[]", type: "virtualserver", category: "Error handling", anchor: "error-handling", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              preferAnnotation: "nginx.org/custom-http-errors serves error pages from a Service, as the community controller does, while VirtualServer errorPages can only return a canned response or redirect.",
              nicMapping: { annotations: { "custom-http-errors": { key: "nginx.org/custom-http-errors", transform: "customHttpErrors" }, "default-backend": { key: "spec.defaultBackend", transform: "defaultBackend" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateErrorPagesVirtualServer" } },
            // Headers
            { community: ["connection-proxy-header"], nic: "nginx.org/keepalive — or — VirtualServer CRD upstreams[].keepalive", type: "annotation", category: "Headers", anchor: "headers", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "connection-proxy-header": { key: "nginx.org/keepalive", transform: "connectionKeepalive", vsField: "keepalive" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            { community: ["custom-headers"], nic: "VirtualServer CRD responseHeaders.add", type: "virtualserver", category: "Headers", anchor: "headers", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true, templateFn: "generateCustomHeadersVS" } },
            // proxy-hide-headers & proxy-pass-headers: NGINX Ingress Controller-only annotations (nginx.org/) — no community equivalent
            { community: ["upstream-vhost", "x-forwarded-prefix"], nic: "nginx.org/upstream-vhost, nginx.org/proxy-set-headers — or — VirtualServer CRD requestHeaders.set", type: "virtualserver", category: "Headers", anchor: "headers", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "upstream-vhost": { key: "nginx.org/upstream-vhost", transform: "upstreamVhost" }, "x-forwarded-prefix": { key: "nginx.org/proxy-set-headers", transform: "proxySetHeader", template: "X-Forwarded-Prefix: ${value}" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateRequestHeadersVS" } },
            // Load Balancing
            { community: ["load-balance"], nic: "nginx.org/lb-method — or — VirtualServer CRD upstreams[].lb-method", type: "annotation", category: "Load balancing", anchor: "load-balancing", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "load-balance": { key: "nginx.org/lb-method", transform: "lbMethod", vsField: "lb-method" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            { community: ["service-upstream"], nic: "nginx.org/use-cluster-ip — or — VirtualServer CRD upstreams[].use-cluster-ip", type: "annotation", category: "Load balancing", anchor: "load-balancing", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "service-upstream": { key: "nginx.org/use-cluster-ip", transform: "goBoolFalse", vsField: "use-cluster-ip" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            { community: ["upstream-hash-by", "upstream-hash-by-subset", "upstream-hash-by-subset-size"], nic: "nginx.org/lb-method — or — VirtualServer CRD upstreams[].lb-method", type: "virtualserver", category: "Load balancing", anchor: "load-balancing", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "upstream-hash-by": { key: "nginx.org/lb-method", transform: "snippetWrap", template: "hash ${value} consistent" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateHashLBVirtualServer" } },
            // mTLS (Client)
            { community: ["auth-tls-error-page", "auth-tls-pass-certificate-to-upstream", "auth-tls-secret", "auth-tls-verify-client", "auth-tls-verify-depth"], nic: "Policy CRD ingressMTLS + snippets", type: "policy", category: "mTLS (client certificate verification)", anchor: "mtls-client", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "Policy", crdInstall: true, templateFn: "generateIngressMTLSPolicy" } },
            { community: ["auth-tls-match-cn"], nic: "Annotation nginx.org/location-snippets", type: "annotation", category: "mTLS (client certificate verification)", anchor: "mtls-client", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "auth-tls-match-cn": { key: "nginx.org/location-snippets", transform: "snippetWrap", template: "if ($ssl_client_s_dn !~ \"${value}\") { return 403; }" } } } },
            // mTLS (Backend)
            { community: ["proxy-ssl-ciphers", "proxy-ssl-name", "proxy-ssl-protocols", "proxy-ssl-secret", "proxy-ssl-server-name", "proxy-ssl-verify", "proxy-ssl-verify-depth"], nic: "Policy CRD egressMTLS", type: "policy", category: "mTLS (backend/egress)", anchor: "mtls-backend", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "Policy", crdInstall: true, templateFn: "generateEgressMTLSPolicy" } },
            // Logging
            { community: ["enable-access-log"], nic: "ConfigMap access-log-off", type: "configmap", category: "Logging", anchor: "logging", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { configMap: { "enable-access-log": { key: "access-log-off", transform: "booleanInvert" } } } },
            { community: ["enable-rewrite-log"], nic: "Annotation nginx.org/location-snippets (rewrite_log directive)", type: "annotation", category: "Logging", anchor: "logging", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "enable-rewrite-log": { key: "nginx.org/location-snippets", transform: "booleanOnOffSnippet", template: "rewrite_log ${value};" } } } },
            // Deprecated
            { community: ["http2-push-preload"], nic: "Not supported (HTTP/2 Server Push was removed from NGINX 1.25.1)", type: "unsupported", category: "Deprecated", anchor: "deprecated", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} },
            // server-tokens: NGINX Ingress Controller-only annotation (nginx.org/server-tokens) — no community equivalent, not in YAML analyzer
            // Request Mirroring
            { community: ["mirror-host", "mirror-request-body", "mirror-target"], nic: "Annotations nginx.org/location-snippets (mirror directive) + nginx.org/server-snippets (internal /mirror location)", type: "annotation", category: "Request mirroring", anchor: "mirroring", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "mirror-target": { key: "nginx.org/location-snippets", transform: "mirrorSnippet" } }, templateFn: "generateMirrorSnippets" } },
            // Proxy Settings
            { community: ["proxy-http-version"], nic: "nginx.org/proxy-http-version — or — VirtualServer CRD upstreams[].proxy-http-version", type: "annotation", category: "Proxy settings", anchor: "proxy-settings", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "proxy-http-version": { key: "nginx.org/proxy-http-version", transform: "direct", vsField: "proxy-http-version" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            // Route Delegation
            { community: ["server-alias"], nic: "VirtualServer CRD (one resource per hostname)", type: "virtualserver", category: "Route delegation", anchor: "route-delegation", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true, templateFn: "generateServerAliasVS" } },
            // OpenTelemetry
            { community: ["enable-opentelemetry"], nic: "ConfigMap otel-exporter-endpoint, otel-trace-in-http, otel-service-name", type: "configmap", category: "OpenTelemetry", anchor: "opentelemetry", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { templateFn: "generateOtelConfigMap" } },
            { community: ["opentelemetry-trust-incoming-span"], nic: "ConfigMap otel-trace-context (global, not per Ingress)", type: "configmap", category: "OpenTelemetry", anchor: "opentelemetry", section: "oss", dualApproach: false, plusRequired: false, verified: "v5.7.0",
              nicMapping: { templateFn: "generateOtelConfigMap" } },
            // Proxy Settings
            { community: ["proxy-next-upstream", "proxy-next-upstream-timeout", "proxy-next-upstream-tries"], nic: "Annotations nginx.org/proxy-next-upstream* — or — VirtualServer CRD upstreams[].next-upstream*", type: "annotation", category: "Proxy settings", anchor: "proxy-settings", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "proxy-next-upstream": { key: "nginx.org/proxy-next-upstream", transform: "direct" }, "proxy-next-upstream-timeout": { key: "nginx.org/proxy-next-upstream-timeout", transform: "direct" }, "proxy-next-upstream-tries": { key: "nginx.org/proxy-next-upstream-tries", transform: "direct" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateProxyNextUpstreamVS" } },
            // Rate Limiting
            { community: ["limit-burst-multiplier", "limit-connections", "limit-rate", "limit-rate-after", "limit-rpm", "limit-rps", "limit-whitelist"], nic: "nginx.org/limit-req-* annotations — or — Policy CRD rateLimit", type: "policy", category: "Rate limiting", anchor: "rate-limiting", section: "oss", dualApproach: true, plusRequired: false,
              nicMapping: { annotations: { "limit-rps": { key: "nginx.org/limit-req-rate", transform: "appendRateUnit" }, "limit-burst-multiplier": { key: "nginx.org/limit-req-burst" } }, crdKind: "Policy", crdInstall: true, templateFn: "generateRateLimitPolicy" } },
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
            { community: ["backend-protocol"], nic: "nginx.org/ssl-services or nginx.org/grpc-services — or — VirtualServer CRD upstreams[].tls.enable, upstreams[].type", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "backend-protocol": { key: "nginx.org/ssl-services", transform: "backendProtocol", vsField: "type" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            { community: ["force-ssl-redirect"], nic: "Annotation nginx.org/redirect-to-https", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "force-ssl-redirect": { key: "nginx.org/redirect-to-https", transform: "goBoolFalse" } } } },
            { community: ["ssl-ciphers"], nic: "Annotation nginx.org/ssl-ciphers", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "ssl-ciphers": { key: "nginx.org/ssl-ciphers", transform: "direct" } } } },
            { community: ["ssl-prefer-server-ciphers"], nic: "Annotation nginx.org/ssl-prefer-server-ciphers", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "ssl-prefer-server-ciphers": { key: "nginx.org/ssl-prefer-server-ciphers", transform: "direct" } } } },
            { community: ["ssl-redirect"], nic: "Annotation nginx.org/ssl-redirect (or nginx.org/redirect-to-https)", type: "annotation", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { annotations: { "ssl-redirect": { key: "nginx.org/ssl-redirect", transform: "goBoolTrue" } } } },
            { community: ["ssl-passthrough"], nic: "TransportServer CRD TLS_PASSTHROUGH", type: "transportserver", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "TransportServer", crdInstall: true, templateFn: "generateSSLPassthroughTransportServer" } },
            { community: ["preserve-trailing-slash"], nic: "Not needed (trailing slash preserved by default)", type: "unsupported", category: "SSL/TLS", anchor: "ssl-tls", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} },
            // Timeouts
            { community: ["proxy-connect-timeout"], nic: "nginx.org/proxy-connect-timeout — or — VirtualServer CRD upstreams[].connect-timeout", type: "annotation", category: "Timeouts", anchor: "timeouts", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "proxy-connect-timeout": { key: "nginx.org/proxy-connect-timeout", transform: "appendTimeUnit", vsField: "connect-timeout" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            { community: ["proxy-read-timeout"], nic: "nginx.org/proxy-read-timeout — or — VirtualServer CRD upstreams[].read-timeout", type: "annotation", category: "Timeouts", anchor: "timeouts", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "proxy-read-timeout": { key: "nginx.org/proxy-read-timeout", transform: "appendTimeUnit", vsField: "read-timeout" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            { community: ["proxy-send-timeout"], nic: "nginx.org/proxy-send-timeout — or — VirtualServer CRD upstreams[].send-timeout", type: "annotation", category: "Timeouts", anchor: "timeouts", section: "oss", dualApproach: true, plusRequired: false, verified: "v5.7.0",
              nicMapping: { annotations: { "proxy-send-timeout": { key: "nginx.org/proxy-send-timeout", transform: "appendTimeUnit", vsField: "send-timeout" } }, crdKind: "VirtualServer", crdInstall: true, templateFn: "generateUpstreamSettingsVS" } },
            // Authentication (External): generic auth_request → externalAuth Policy (OSS, recommended).
            // OIDC itself (Plus: oidcNative or oidc Policy) is documented as an alternative in the OIDC authentication section.
            { community: ["auth-cache-duration", "auth-cache-key", "auth-method", "auth-proxy-set-headers", "auth-request-redirect", "auth-response-headers", "auth-signin", "auth-signin-redirect-param", "auth-snippet", "auth-url"], nic: "Policy CRD externalAuth (+ nginx.org/policies annotation)", type: "policy", category: "Authentication (external)", anchor: "authentication-external", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "Policy", crdInstall: true, templateFn: "generateExternalAuthPolicy" } },
            { community: ["auth-keepalive", "auth-keepalive-requests", "auth-keepalive-share-vars", "auth-keepalive-timeout"], nic: "No direct equivalent — NGINX Ingress Controller has no keepalive setting for the external-auth Service alone", type: "annotation", category: "Authentication (external)", anchor: "authentication-external", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { templateFn: "generateAuthKeepaliveNote" } },
            { community: ["auth-always-set-cookie"], nic: "Annotation nginx.org/location-snippets (auth_request_set directive)", type: "annotation", category: "Authentication (external)", anchor: "authentication-external", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { templateFn: "generateAuthCookieNote" } },
            { community: ["enable-global-auth"], nic: "Not applicable (NGINX Ingress Controller has no global external auth)", type: "unsupported", category: "Authentication (external)", anchor: "authentication-external", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} },
            // Session Affinity (OSS + Plus)
            { community: ["affinity", "affinity-mode", "session-cookie-change-on-failure", "session-cookie-conditional-samesite-none", "session-cookie-domain", "session-cookie-expires", "session-cookie-max-age", "session-cookie-name", "session-cookie-path", "session-cookie-samesite", "session-cookie-secure"], nic: "VirtualServer CRD sessionCookie", type: "virtualserver", category: "Session affinity / sticky sessions", anchor: "session-affinity", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: { crdKind: "VirtualServer", crdInstall: true, templateFn: "generateSessionAffinityVS" } },
            // Plus: WAF
            // ModSecurity / WAF — no OSS replacement; Plus users can use F5 WAF for NGINX
            { community: ["enable-modsecurity", "enable-owasp-core-rules", "modsecurity-snippet", "modsecurity-transaction-id"], nic: "No direct replacement on NGINX Open Source — F5 WAF for NGINX needs NGINX Plus", type: "unsupported", category: "ModSecurity / WAF", anchor: "modsecurity", section: "oss", dualApproach: false, plusRequired: false,
              nicMapping: {} }
        ];

        const ANNOTATION_LOOKUP = new Map();
        ANNOTATION_MAPPINGS.forEach(function(mapping, idx) {
            mapping.community.forEach(function(name) {
                ANNOTATION_LOOKUP.set(name, idx);
            });
        });

        // Translate a community annotation value to its NIC equivalent.
        // Returns either a string (the translated value) or an object
        // { value, note } when a non-trivial substitution was applied.
        // { value: null, note } means NIC has no annotation for this value:
        // the caller reports the note instead of emitting a swap.
        // `found` (the entry's found annotations) enables cross-annotation
        // transforms like appendBufferSize.
        function translateValue(value, transform, template, found) {
            // defaultBackend never has an annotation form, so even an empty value
            // has to reach its case rather than become an empty swap.
            if (!value && value !== '0' && transform !== 'defaultBackend') return value;
            switch (transform) {
                case 'direct': return value;
                // A community boolean onto an NGINX Ingress Controller key that
                // admission validates as a bool: ParseBool, then the community
                // default for any other value, which copied would be rejected.
                case 'goBoolTrue':
                case 'goBoolFalse': {
                    let dflt = transform === 'goBoolTrue';
                    let b = goBool(value, null);
                    if (b !== null) return String(b);
                    return { value: String(dflt), note: '"' + value + '" is not a boolean, so the community controller used its default, ' + dflt };
                }
                case 'booleanInvert': return value === 'true' ? 'false' : value === 'false' ? 'true' : value;
                case 'appendRateUnit': return /r\/[sm]$/.test(value) ? value : value + 'r/s';
                case 'appendTimeUnit': return /[smhd]$/.test(value) ? value : value + 's';
                case 'appendBufferSize': {
                    // The community writes proxy_buffers <number> <proxy-buffer-size>,
                    // and proxy-buffer-size defaults to 4k there.
                    if (/\s/.test(value)) return value;
                    let size = getAnnotationValue(found || [], 'proxy-buffer-size');
                    if (size) return value + ' ' + unwrapTranslated(translateValue(size, 'nicSize')).value;
                    return { value: value + ' 4k', note: '4k, the community default proxy-buffer-size' };
                }
                // The community accepts a b/B suffix and NIC does not: bytes are
                // the bare number. Sizes also refuse g/G, which offsets take.
                case 'nicOffset': return String(value).trim().replace(/^(\d+)[bB]$/, '$1');
                case 'nicSize': {
                    let v = String(value).trim().replace(/^(\d+)[bB]$/, '$1');
                    if (/^\d+[gG]$/.test(v)) return { value: (parseInt(v, 10) * 1024) + 'm', note: v + ' rewritten in megabytes — NGINX Ingress Controller sizes take k or m only' };
                    return v;
                }
                // NIC parses nginx.org/proxy-buffering as a bool and rejects the
                // Ingress for "on"/"off", the only values the community takes.
                // NIC sends Connection itself, from upstream keepalive: "" with it,
                // close without. Setting the header as well sends both values.
                case 'connectionKeepalive': {
                    let v = String(value).trim().toLowerCase();
                    if (v === 'close') return '0';
                    if (v === 'keep-alive') return { value: '320', note: 'the community upstream-keepalive-connections default' };
                    return { value: null, note: 'The community accepts only close or keep-alive here.' };
                }
                case 'onOffBool': {
                    let v = String(value).trim().toLowerCase();
                    return v === 'on' ? 'true' : v === 'off' ? 'false' : value;
                }
                case 'snippetWrap': return template ? template.replace('${value}', sanitizeSnippetValue(value)) : value;
                case 'booleanOnOffSnippet': return template ? template.replace('${value}', value === 'true' ? 'on' : value === 'false' ? 'off' : sanitizeSnippetValue(value)) : value;
                case 'backendProtocol': return value; // the key depends on the value: translateBackendProtocol
                case 'corsSnippet': return value; // CORS is a Policy under both strategies: generateCORSPolicy
                case 'lbMethod': {
                    // NIC's nginx.org/lb-method does not support every value the
                    // community controller accepts. Map known unsupported values
                    // to the closest equivalent and surface a note.
                    // The community's chash, chashsubset and sticky_* are Lua
                    // balancers that only upstream-hash-by and affinity configure;
                    // NIC rejects the Ingress for any of them.
                    // ewma scored each backend by a decayed average of connect plus
                    // response time (ewma.lua). least_time last_byte also picks by
                    // average time to the full response, and is NGINX Open Source since
                    // 1.31.0, accepted on OSS by NIC v5.7.0's ParseLBMethod.
                    let lbAliases = { 'ewma': 'least_time last_byte', 'round_robin': 'round_robin' };
                    let trimmed = (value || '').trim();
                    // hasOwnProperty: "constructor" or "toString" must not reach
                    // Object.prototype (they did, and emitted a function's source).
                    if (Object.prototype.hasOwnProperty.call(lbAliases, trimmed) && lbAliases[trimmed] !== trimmed) {
                        return { value: lbAliases[trimmed], note: trimmed + ' has no NGINX equivalent of that name; ' + lbAliases[trimmed] + ' also picks the backend with the lowest average response time, and weighs active connections too' };
                    }
                    if (/^(chash|chashsubset|sticky_balanced|sticky_persistent)$/.test(trimmed)) {
                        return { value: null, note: trimmed + ' is set by upstream-hash-by or affinity, which migrate separately; NGINX Ingress Controller has no lb-method by that name.' };
                    }
                    // The community controller accepts only these names; anything
                    // else fell back to round_robin there, and NIC rejects it.
                    if (!/^(round_robin|least_conn|ip_hash|random(?: two(?: least_conn)?)?)$/.test(trimmed)) {
                        return { value: null, note: '"' + trimmed + '" is not a load-balancing method; the community controller used round_robin, which needs no annotation.' };
                    }
                    return value;
                }
                case 'upstreamVhost': {
                    // NIC validates nginx.org/upstream-vhost as an RFC 1123
                    // subdomain and rejects the whole Ingress otherwise. The
                    // community annotation also took ports and $variables.
                    let host = String(value).trim().toLowerCase();
                    if (host.length <= 253 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(host)) {
                        return host === value ? value : { value: host, note: 'lowercased — NGINX Ingress Controller accepts only a lowercase hostname' };
                    }
                    return { value: null, note: 'nginx.org/upstream-vhost takes only a literal lowercase hostname, with no port or variables, and NGINX Ingress Controller rejects the Ingress otherwise. Switch the migration strategy to CRD-first: VirtualServer requestHeaders.set accepts it.' };
                }
                case 'proxySetHeader': {
                    // nginx.org/proxy-set-headers is a comma-separated list of
                    // literal values: NIC rejects $, and a comma splits the entry.
                    if (/[$,"\\\r\n]/.test(value)) {
                        return { value: null, note: 'nginx.org/proxy-set-headers takes only literal values, and NGINX Ingress Controller rejects $ in them, so capture groups such as $1 have no annotation equivalent. Switch the migration strategy to CRD-first.' };
                    }
                    return template ? template.replace('${value}', String(value).trim()) : value;
                }
                case 'customHttpErrors': {
                    // NIC rejects 499 in error_page, and so the whole Ingress.
                    let codes = String(value).split(',').map(function(c) { return c.trim(); }).filter(Boolean);
                    let kept = codes.filter(function(c) { return c !== '499'; });
                    let notes = [];
                    if (kept.length < codes.length) notes.push('499 dropped — NGINX Ingress Controller rejects it in error_page');
                    if (!getAnnotationValue(found || [], 'default-backend')) {
                        notes.push('errors go to this Ingress\'s spec.defaultBackend, so set one — the community controller fell back to its global default backend');
                    }
                    if (kept.length === 0) return { value: null, note: 'No status code survives: NGINX Ingress Controller rejects 499 in error_page.' };
                    let joined = kept.join(',');
                    return notes.length || joined !== value ? { value: joined, note: notes.join('; ') || null } : value;
                }
                case 'defaultBackend': {
                    // The community annotation names a Service; NIC reads the
                    // Ingress's spec.defaultBackend, which has no annotation form.
                    let svc = String(value || '').trim() || '<service>';
                    if (getAnnotationValue(found || [], 'custom-http-errors')) {
                        return { value: null, note: 'Set the Ingress spec.defaultBackend to Service "' + svc + '" (with its port) — it is the only place nginx.org/custom-http-errors sends intercepted errors, and it also serves requests that match no rule.' };
                    }
                    return { value: null, note: 'Set the Ingress spec.defaultBackend to Service "' + svc + '" for requests that match no rule. NGINX Ingress Controller has no annotation for the community fallback used when a Service has no ready endpoints; on NGINX Plus, VirtualServer upstreams[].backup is the closest equivalent.' };
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

        function getAnnotationValue(foundAnnotations, name) {
            let found = foundAnnotations.find(function(a) { return a.annotation === name; });
            return found ? found.value : null;
        }

        // backend-protocol values with nothing to emit, in either form.
        function backendProtocolNote(upper) {
            if (upper === 'HTTP') return 'HTTP is the default protocol in NGINX Ingress Controller. Remove this annotation — no replacement is needed.';
            if (upper === 'AUTO_HTTP' || upper === 'FCGI') return upper + ' has no direct equivalent in NGINX Ingress Controller. Review your backend protocol strategy before migrating.';
            // backendprotocol Parse logs the ValidationError and returns HTTP.
            if (['HTTPS', 'GRPC', 'GRPCS'].indexOf(upper) === -1) return '"' + upper.toLowerCase() + '" is not a backend protocol the community controller knew (auto_http, http, https, grpc, grpcs, fcgi), so it used HTTP, the NGINX Ingress Controller default too. Remove this annotation.';
            return null;
        }

        // VirtualServer header values take NGINX variables only in braces:
        // $host must be written ${host}.
        function braceVariables(value) { return String(value).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, '${$1}'); }

        // --- Assembly: one complete migration per Ingress ------------------------
        // The analyzer used to emit one single-feature VirtualServer per
        // annotation, each bound to the first host and path. Applied together,
        // NIC accepted one per host and rejected the rest ("host is taken"), and
        // none of them carried TLS. Here every finding is translated into
        // FRAGMENTS — upstream fields, route fields, server snippets, Policies,
        // annotations — and the fragments are assembled onto resources built from
        // the real Ingress: one VirtualServer per host under CRD-first, one
        // migrated Ingress under annotation-first. nic-migrate's convert runs this
        // same code, so the page and the CLI cannot disagree.

        let COMMUNITY_PREFIX = 'nginx.ingress.kubernetes.io/';
        let NIC_API = 'k8s.nginx.org/v1';

        function isMap(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
        function str(v) { return v === null || v === undefined ? '' : String(v); }
        function truthy(v) { return /^(true|1|on|yes)$/i.test(str(v).trim()); }
        function dnsName(s, fallback) {
            let n = str(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
            return n || fallback || 'app';
        }

        // The Ingress model: everything a migration needs from the manifest, read
        // through the parsed document rather than line regexes.
        function ingressModel(doc) {
            let md = isMap(doc.metadata) ? doc.metadata : {};
            let spec = isMap(doc.spec) ? doc.spec : {};
            let annotations = isMap(md.annotations) ? md.annotations : {};
            let community = {};
            Object.keys(annotations).forEach(function(k) {
                if (k.indexOf(COMMUNITY_PREFIX) === 0) community[k.slice(COMMUNITY_PREFIX.length)] = str(annotations[k]);
            });
            let tlsByHost = {};
            (Array.isArray(spec.tls) ? spec.tls : []).forEach(function(t) {
                if (!isMap(t)) return;
                (Array.isArray(t.hosts) ? t.hosts : []).forEach(function(h) { tlsByHost[str(h)] = t.secretName ? str(t.secretName) : ''; });
            });
            let backendOf = function(b) {
                if (!isMap(b)) return null;
                // networking.k8s.io/v1, then the extensions/v1beta1 shape.
                if (isMap(b.service)) {
                    let p = isMap(b.service.port) ? b.service.port : {};
                    return { service: b.service.name ? str(b.service.name) : null, port: p.number !== undefined ? p.number : (p.name !== undefined ? str(p.name) : null) };
                }
                if (b.serviceName) return { service: str(b.serviceName), port: b.servicePort !== undefined ? b.servicePort : null };
                if (isMap(b.resource)) return { resource: b.resource };
                return null;
            };
            let rules = (Array.isArray(spec.rules) ? spec.rules : []).filter(isMap);
            let hosts = [];
            let hostless = [];
            rules.forEach(function(r) {
                let paths = ((isMap(r.http) && Array.isArray(r.http.paths)) ? r.http.paths : []).filter(isMap).map(function(p) {
                    return { path: p.path ? str(p.path) : '/', pathType: p.pathType ? str(p.pathType) : 'ImplementationSpecific', backend: backendOf(p.backend) };
                });
                if (!r.host) { hostless.push.apply(hostless, paths); return; }
                let host = str(r.host);
                let existing = hosts.find(function(h) { return h.host === host; });
                if (existing) existing.paths = existing.paths.concat(paths);
                else hosts.push({ host: host, paths: paths, tlsSecret: Object.prototype.hasOwnProperty.call(tlsByHost, host) ? tlsByHost[host] : null });
            });
            return {
                name: md.name ? str(md.name) : null,
                namespace: md.namespace ? str(md.namespace) : null,
                apiVersion: str(doc.apiVersion),
                ingressClassName: spec.ingressClassName ? str(spec.ingressClassName) : (annotations['kubernetes.io/ingress.class'] ? str(annotations['kubernetes.io/ingress.class']) : null),
                annotations: annotations,
                community: community,
                defaultBackend: backendOf(spec.defaultBackend || spec.backend),
                hosts: hosts,
                hostless: hostless,
                tls: (Array.isArray(spec.tls) ? spec.tls : []).filter(isMap),
                doc: doc
            };
        }

        // --- Translators -------------------------------------------------------
        // One per mapping that needs more than a key rename. Each reads the
        // community annotations of its entry (`a` maps short name → value) and
        // writes FRAGMENTS onto `f`; assemble() places them on the resources it
        // builds from the real Ingress. A translator marks what it consumed with
        // use(); anything a matched entry leaves unconsumed is reported, so a
        // recognised annotation can no longer vanish under "Analysis complete".
        //
        // Fragment shapes, all optional:
        //   f.upstream[field]        VirtualServer upstream field, every upstream
        //   f.proxy[field]           route action.proxy field (requestHeaders, ...)
        //   f.location / f.server    snippet lines (location / server context)
        //   f.http                   ConfigMap http-snippets lines
        //   f.policies               [{ name, spec, onIngress, needsTls, comments }]
        //   f.ann[key]               nginx.org/* annotation on a migrated Ingress
        //   f.cm[key]                NIC ConfigMap data
        //   f.rewrite, f.regexPaths, f.appRoot, f.redirect, f.canary, f.sticky,
        //   f.aliases, f.wwwRedirect, f.passthrough, f.errorCodes: one feature each,
        //   placed by buildCrd / buildIngress

        function nicDuration(v) { let s = String(v).trim(); return /^\d+$/.test(s) ? s + 's' : s; }

        // A community integer annotation as the community controller read it:
        // strconv.Atoi, so "10m" or "2.5" is not a number, and on an invalid
        // value it kept its default. Returns null for those, after a note, so
        // the caller emits nothing rather than parseInt's partial read or NaN.
        // `rejects`: limit-rps, limit-rpm and limit-connections instead return
        // their ValidationError (ratelimit/main.go, controller-v1.15.1), so
        // Extract fails and the community controller rejects the whole Ingress.
        function communityInt(a, name, ctx, rejects) {
            let s = str(a[name]).trim();
            if (/^[-+]?\d+$/.test(s)) return parseInt(s, 10);
            ctx.note(name, name + ' "' + s + '" is not a whole number, so the community controller ' +
                (rejects ? 'rejected this Ingress (annotation validation is on by default); fix the value before migrating. Nothing was migrated for it.' : 'ignored it and kept its default; nothing was migrated.'), 'warning');
            return null;
        }

        // A community boolean annotation as the community controller read it:
        // strconv.ParseBool, so "on" and "yes" are not booleans. What it did
        // with one depends on the parser (controller-v1.15.1): most kept their
        // default (`invalid` true or false), and those that return the
        // ValidationError made Extract reject the Ingress ('rejects': the note
        // says so, and the caller emits nothing for it, as for false).
        let GO_TRUE = /^(1|t|T|TRUE|true|True)$/, GO_FALSE = /^(0|f|F|FALSE|false|False)$/;
        // custom-http-errors entries strconv.Atoi rejects; any one voids them all.
        function badErrorCodes(a) { return commaList(a['custom-http-errors']).filter(function(c) { return !/^[-+]?\d+$/.test(c); }); }
        // ParseBool without a note, for the assembler: `dflt` on any other value.
        function goBool(v, dflt) { let s = str(v).trim(); return GO_TRUE.test(s) ? true : GO_FALSE.test(s) ? false : dflt; }
        function communityBool(a, name, ctx, invalid) {
            let s = str(a[name]).trim();
            if (GO_TRUE.test(s)) return true;
            if (GO_FALSE.test(s)) return false;
            ctx.note(name, name + ' "' + s + '" is not a boolean, so the community controller ' + (invalid === 'rejects'
                ? 'rejected this Ingress (annotation validation is on by default); fix the value before migrating. Nothing was migrated for it.'
                : 'read it as ' + invalid + '; it migrates as ' + invalid + '.'), 'warning');
            return invalid === 'true';
        }

        // Community header lists are comma-separated; CORS also accepts "*".
        function commaList(v) { return String(v || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean); }

        // Seconds → the largest whole NGINX unit, for cookie expiry.
        function secondsToNginx(secs) {
            if (secs > 0 && secs % 86400 === 0) return (secs / 86400) + 'd';
            if (secs > 0 && secs % 3600 === 0) return (secs / 3600) + 'h';
            if (secs > 0 && secs % 60 === 0) return (secs / 60) + 'm';
            return secs + 's';
        }

        // A community auth-url or mirror-target → { service, namespace, port, path, external }.
        function serviceFromURL(url) {
            let m = String(url || '').trim().match(/^(https?):\/\/([^\/:?#]+)(?::(\d+))?([^?#]*)?(\?[^#]*)?/i);
            if (!m) return null;
            let host = m[2].toLowerCase();
            let parts = host.split('.');
            let svcIdx = parts.indexOf('svc');
            let out = { scheme: m[1].toLowerCase(), host: host, port: m[3] ? parseInt(m[3], 10) : null, path: m[4] || '/', query: m[5] || '', external: true, service: null, namespace: null };
            if (svcIdx >= 1 && svcIdx <= 2) {
                // name.namespace.svc[.cluster.local]
                out.service = parts[0];
                out.namespace = svcIdx === 2 ? parts[1] : null;
                out.external = false;
            } else if (parts.length === 1 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(host) && host !== 'localhost') {
                // A bare name resolves to a Service in the Ingress's namespace.
                out.service = host;
                out.external = false;
            } else if (parts.length === 2 && /^[a-z0-9-]+$/.test(parts[1]) && !/^(com|net|org|io|dev|app|cloud|co|local)$/.test(parts[1])) {
                // name.namespace
                out.service = parts[0];
                out.namespace = parts[1];
                out.external = false;
            }
            return out;
        }

        let TRANSLATORS = {
            // whitelist-source-range / denylist-source-range → accessControl.
            // NIC applies allow and deny from DIFFERENT Policies as allow-only
            // ("If a resource references both allow and deny lists, NGINX
            // Ingress Controller uses only the allow list policies"), and one
            // Policy takes exactly one of them. The community controller renders
            // deny first, then allow, then "deny all": an address both allowed
            // and denied is denied. So an allow AND a deny list become one allow
            // list with the denies that overlap it ahead of it, in the same
            // location (below) — never two Policies, which would silently drop
            // the deny list. A deny list on its own is a deny Policy.
            generateAccessControlPolicy: function(a, f, ctx) {
                let allow = commaList(a['whitelist-source-range']);
                let deny = commaList(a['denylist-source-range']);
                ctx.use('whitelist-source-range', 'denylist-source-range');
                if (!allow.length && !deny.length) return;
                let name = ctx.name('access-control');
                if (allow.length) {
                    let policy = { name: name, spec: { accessControl: { allow: allow } }, onIngress: true, comments: { 'spec.accessControl.allow': 'whitelist-source-range' } };
                    if (deny.length) {
                        // The community order is deny, allow, deny all, in the
                        // location. A deny that overlaps an allowed range (inside
                        // it, or holding it) must come first; one that misses
                        // every allowed range is refused by deny all already.
                        // A location with access rules of its own inherits none
                        // from its server, and a Policy in spec.policies or
                        // nginx.org/policies renders at server level: a
                        // location-snippet deny beside it lifted the allow list
                        // (nginx 1.31.7: an address outside it got 200). A
                        // route's own Policy renders in the location after its
                        // snippets; an Ingress cannot order a Policy after a
                        // snippet, so it carries the whole list as a snippet.
                        let overlap = deny.filter(function(d) { return allow.some(function(al) { return cidrContains(al, d) || cidrContains(d, al); }); });
                        if (overlap.length) { policy.perRoute = true; policy.denyFirst = overlap; policy.denySource = 'denylist-source-range'; }
                        ctx.note('denylist-source-range', 'NGINX Ingress Controller applies only the allow list when a resource references allow and deny Policies, so the deny list is not a Policy here. '
                            + (overlap.length ? 'The denied addresses that overlap the allowed ranges (' + overlap.join(', ') + ') are denied first in each route, ahead of the allow list: CRD-first references the allow Policy from every route (routes[].policies) beside a location-snippets deny; annotation-first writes the whole ordered list as nginx.org/location-snippets, as an Ingress cannot place a Policy after a snippet.' : 'None of the denied ranges overlaps an allowed one, so allow-only already blocks them.'));
                    }
                    f.policies.push(policy);
                } else {
                    f.policies.push({ name: name, spec: { accessControl: { deny: deny } }, onIngress: true, comments: { 'spec.accessControl.deny': 'denylist-source-range' } });
                }
            },

            generateCORSPolicy: function(a, f, ctx) {
                ctx.use('enable-cors', 'cors-allow-origin', 'cors-allow-methods', 'cors-allow-headers', 'cors-allow-credentials', 'cors-expose-headers', 'cors-max-age');
                if (!(a['enable-cors'] !== undefined && communityBool(a, 'enable-cors', ctx, 'false'))) {
                    let set = Object.keys(a).filter(function(k) { return /^cors-/.test(k); });
                    ctx.note('enable-cors', 'CORS is configured but enable-cors is not "true", so the community controller ignored ' + (set.length ? set.join(', ') : 'these annotations') + '; nothing is migrated.');
                    return;
                }
                // Community defaults (cors/main.go): every origin, credentials on,
                // these methods and headers, a max-age of 20 days.
                let origins = commaList(a['cors-allow-origin'] || '*');
                let creds = a['cors-allow-credentials'] === undefined ? true : communityBool(a, 'cors-allow-credentials', ctx, 'true');
                let methods = commaList(a['cors-allow-methods'] || 'GET, PUT, POST, DELETE, PATCH, OPTIONS');
                let headers = commaList(a['cors-allow-headers'] || 'DNT,Keep-Alive,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization');
                let maxAge = parseInt(a['cors-max-age'] || '1728000', 10);
                let comments = {};
                let spec = {};
                // NIC rejects "*" with allowCredentials: true, and so do browsers:
                // the community controller echoed the request's Origin instead.
                if (origins.indexOf('*') !== -1 && creds) {
                    spec.allowOrigin = ['https://app.example.com'];
                    ctx.todo('spec.cors.allowOrigin', 'list the origins your clients use — "*" is invalid with credentials (the community controller echoed any Origin back)');
                } else {
                    spec.allowOrigin = origins;
                }
                comments['spec.cors.allowOrigin'] = 'cors-allow-origin' + (a['cors-allow-origin'] ? '' : ' (community default *)');
                // HEAD is implied by GET in NIC and rejected beside it.
                spec.allowMethods = methods.filter(function(m) { return !(m.toUpperCase() === 'HEAD' && methods.some(function(x) { return x.toUpperCase() === 'GET'; })); });
                comments['spec.cors.allowMethods'] = 'cors-allow-methods' + (a['cors-allow-methods'] ? '' : ' (community default)');
                // Browsers set these themselves; NIC rejects them in allowHeaders.
                let forbidden = /^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;
                let dropped = headers.filter(function(h) { return forbidden.test(h); });
                spec.allowHeaders = headers.filter(function(h) { return !forbidden.test(h); });
                comments['spec.cors.allowHeaders'] = 'cors-allow-headers' + (a['cors-allow-headers'] ? '' : ' (community default)');
                if (dropped.length) ctx.note('cors-allow-headers', 'Dropped ' + dropped.join(', ') + ' from allowHeaders — browsers send these themselves and NGINX Ingress Controller rejects them there.');
                if (creds) { spec.allowCredentials = true; comments['spec.cors.allowCredentials'] = 'cors-allow-credentials' + (a['cors-allow-credentials'] === undefined ? ' (community default true)' : ''); }
                if (a['cors-expose-headers']) { spec.exposeHeaders = commaList(a['cors-expose-headers']); comments['spec.cors.exposeHeaders'] = 'cors-expose-headers'; }
                if (!isNaN(maxAge)) { spec.maxAge = maxAge; comments['spec.cors.maxAge'] = 'cors-max-age' + (a['cors-max-age'] ? '' : ' (community default 20 days)'); }
                f.policies.push({ name: ctx.name('cors'), spec: { cors: spec }, onIngress: true, comments: comments });
            },

            generateBasicAuthPolicy: function(a, f, ctx) {
                ctx.use('auth-type', 'auth-secret', 'auth-secret-type', 'auth-realm');
                // auth Parse returns first without auth-type (basic|digest).
                if (!/basic|digest/.test(str(a['auth-type']))) {
                    let set = ['auth-type', 'auth-secret', 'auth-secret-type', 'auth-realm'].filter(function(k) { return a[k] !== undefined; });
                    ctx.note('auth-type', (a['auth-type'] === undefined ? 'No auth-type' : 'auth-type "' + a['auth-type'] + '" is neither basic nor digest') + ', so the community controller ignored ' + set.join(', ') + '; nothing is migrated.');
                    return;
                }
                if (a['auth-type'] && a['auth-type'] !== 'basic') {
                    ctx.note('auth-type', 'auth-type "' + a['auth-type'] + '" (digest) has no NGINX Ingress Controller equivalent: NGINX Ingress Controller supports basic authentication only.', 'warning');
                    return;
                }
                let secret = String(a['auth-secret'] || '').replace(/^[^/]+\//, '');
                if (/\//.test(String(a['auth-secret'] || ''))) ctx.note('auth-secret', 'NGINX Ingress Controller reads the Secret from the resource\'s own namespace; the namespace prefix was dropped.');
                // NIC v5.7.0 validates a Secret by its role's keys, not its type,
                // so the community's Opaque Secret works once its key is renamed.
                let secretNote = 'NGINX Ingress Controller reads the htpasswd content from a key named htpasswd; the community controller read it from a key named auth. Rename the key (the Secret can stay Opaque).';
                if (a['auth-secret-type'] === 'auth-map') secretNote += ' auth-secret-type auth-map (one user per key) has no NGINX Ingress Controller form: build one htpasswd file from the entries.';
                ctx.note('auth-secret', secretNote);
                if (ctx.strategy === 'annotation') {
                    // basicAuth is not on NIC's list of Policies an Ingress accepts;
                    // the annotations are the Ingress form.
                    f.ann['nginx.org/basic-auth-secret'] = secret || 'basic-auth';
                    ctx.annComment('nginx.org/basic-auth-secret', 'auth-secret');
                    if (!secret) ctx.todo('ann.nginx.org/basic-auth-secret', 'name the htpasswd Secret');
                    if (a['auth-realm']) { f.ann['nginx.org/basic-auth-realm'] = a['auth-realm']; ctx.annComment('nginx.org/basic-auth-realm', 'auth-realm'); }
                    return;
                }
                let spec = { secret: secret || 'basic-auth' };
                if (a['auth-realm']) spec.realm = a['auth-realm'];
                if (!secret) ctx.todo('spec.basicAuth.secret', 'name the htpasswd Secret');
                f.policies.push({ name: ctx.name('basic-auth'), spec: { basicAuth: spec }, onIngress: false, comments: { 'spec.basicAuth.secret': 'auth-secret', 'spec.basicAuth.realm': 'auth-realm' } });
            },

            generateIngressMTLSPolicy: function(a, f, ctx) {
                ctx.use('auth-tls-secret', 'auth-tls-verify-client', 'auth-tls-verify-depth', 'auth-tls-pass-certificate-to-upstream', 'auth-tls-error-page');
                let raw = String(a['auth-tls-secret'] || '');
                let secret = raw.replace(/^[^/]+\//, '');
                // authtls Parse returns before reading the rest when
                // auth-tls-secret is missing: none of them took effect.
                if (!secret) {
                    let set = ['auth-tls-verify-client', 'auth-tls-verify-depth', 'auth-tls-pass-certificate-to-upstream', 'auth-tls-error-page'].filter(function(k) { return a[k] !== undefined; });
                    ctx.note('auth-tls-secret', 'No auth-tls-secret, so the community controller ignored ' + set.join(', ') + '; nothing is migrated.');
                    return;
                }
                let spec = { clientCertSecret: secret };
                let verify = a['auth-tls-verify-client'];
                spec.verifyClient = verify ? String(verify) : 'on';
                if (verify === 'optional_no_ca') ctx.note('auth-tls-verify-client', 'optional_no_ca keeps the connection without verifying the chain; NGINX Ingress Controller accepts it, but it is rarely what a migration wants.');
                // Depth 0 meant the community default of 1; NGINX Ingress Controller would take 0 as given.
                let tlsDepth = a['auth-tls-verify-depth'] ? communityInt(a, 'auth-tls-verify-depth', ctx) : null;
                if (tlsDepth !== null) spec.verifyDepth = tlsDepth || 1;
                f.policies.push({ name: ctx.name('ingress-mtls'), spec: { ingressMTLS: spec }, onIngress: true, needsTls: true,
                    comments: { 'spec.ingressMTLS.clientCertSecret': 'auth-tls-secret', 'spec.ingressMTLS.verifyClient': a['auth-tls-verify-client'] ? 'auth-tls-verify-client' : 'auth-tls-verify-client (community default on)', 'spec.ingressMTLS.verifyDepth': 'auth-tls-verify-depth' } });
                ctx.note('auth-tls-secret', 'NGINX Ingress Controller reads the CA from the Secret\'s ca.crt key, as the community controller did, so the same Secret works as it is (v' + ctx.nicVersion + ' accepts an Opaque Secret). NGINX Ingress Controller reads the Secret from the Policy\'s namespace' + (/\//.test(raw) ? ', so the namespace prefix was dropped' : '') + '. The Policy only takes effect on a host that terminates TLS.');
                // Headers the community controller always sent upstream when
                // verifying, plus the certificate itself on request.
                f.location.push('proxy_set_header ssl-client-verify $ssl_client_verify;');
                f.location.push('proxy_set_header ssl-client-subject-dn $ssl_client_s_dn;');
                f.location.push('proxy_set_header ssl-client-issuer-dn $ssl_client_i_dn;');
                ['proxy_set_header ssl-client-verify', 'proxy_set_header ssl-client-subject-dn', 'proxy_set_header ssl-client-issuer-dn'].forEach(function(l) { ctx.snippetSource(l, 'auth-tls-secret (the community controller sent these upstream)'); });
                if (a['auth-tls-pass-certificate-to-upstream'] !== undefined && communityBool(a, 'auth-tls-pass-certificate-to-upstream', ctx, 'rejects')) {
                    f.location.push('proxy_set_header ssl-client-cert $ssl_client_escaped_cert;');
                    ctx.snippetSource('proxy_set_header ssl-client-cert', 'auth-tls-pass-certificate-to-upstream');
                }
                if (a['auth-tls-error-page']) {
                    f.server.push('error_page 495 496 = ' + sanitizeSnippetValue(a['auth-tls-error-page']) + ';');
                    ctx.snippetSource('error_page 495', 'auth-tls-error-page');
                }
            },

            generateEgressMTLSPolicy: function(a, f, ctx) {
                ctx.use('proxy-ssl-secret', 'proxy-ssl-verify', 'proxy-ssl-verify-depth', 'proxy-ssl-ciphers', 'proxy-ssl-protocols', 'proxy-ssl-name', 'proxy-ssl-server-name');
                let raw = String(a['proxy-ssl-secret'] || '');
                let secret = raw.replace(/^[^/]+\//, '');
                // proxyssl Parse returns before reading the rest when
                // proxy-ssl-secret is missing: none of them took effect.
                if (!secret) {
                    let set = ['proxy-ssl-verify', 'proxy-ssl-verify-depth', 'proxy-ssl-ciphers', 'proxy-ssl-protocols', 'proxy-ssl-name', 'proxy-ssl-server-name'].filter(function(k) { return a[k] !== undefined; });
                    ctx.note('proxy-ssl-secret', 'No proxy-ssl-secret, so the community controller ignored ' + set.join(', ') + '; nothing is migrated.');
                    return;
                }
                // verify and server-name take on|off; any other value was off.
                let onOff = function(name) {
                    let s = str(a[name]).trim();
                    if (s && s !== 'on' && s !== 'off') ctx.note(name, name + ' "' + s + '" is not on or off, so the community controller used off; it migrates as off.', 'warning');
                    return s === 'on';
                };
                let spec = {};
                let comments = {};
                spec.tlsSecret = secret; comments['spec.egressMTLS.tlsSecret'] = 'proxy-ssl-secret (tls.crt, tls.key)';
                let verify = onOff('proxy-ssl-verify');
                if (verify) {
                    spec.verifyServer = true;
                    // NIC v5.7.0 resolves tlsSecret with the TLS role and
                    // trustedCertSecret with the CA role, by keys, not type: the
                    // community proxy-ssl-secret carries tls.crt, tls.key and ca.crt,
                    // so the one Secret serves both.
                    spec.trustedCertSecret = secret;
                    comments['spec.egressMTLS.verifyServer'] = 'proxy-ssl-verify';
                    comments['spec.egressMTLS.trustedCertSecret'] = 'proxy-ssl-secret (its ca.crt)';
                }
                let sslDepth = a['proxy-ssl-verify-depth'] ? communityInt(a, 'proxy-ssl-verify-depth', ctx) : null;
                if (sslDepth !== null) { spec.verifyDepth = sslDepth || 1; comments['spec.egressMTLS.verifyDepth'] = 'proxy-ssl-verify-depth'; }
                if (a['proxy-ssl-ciphers']) { spec.ciphers = a['proxy-ssl-ciphers']; comments['spec.egressMTLS.ciphers'] = 'proxy-ssl-ciphers'; }
                if (a['proxy-ssl-protocols']) { spec.protocols = a['proxy-ssl-protocols']; comments['spec.egressMTLS.protocols'] = 'proxy-ssl-protocols'; }
                if (onOff('proxy-ssl-server-name')) { spec.serverName = true; comments['spec.egressMTLS.serverName'] = 'proxy-ssl-server-name'; }
                if (a['proxy-ssl-name']) { spec.sslName = a['proxy-ssl-name']; comments['spec.egressMTLS.sslName'] = 'proxy-ssl-name'; }
                if (!Object.keys(spec).length) return;
                f.policies.push({ name: ctx.name('egress-mtls'), spec: { egressMTLS: spec }, onIngress: true, comments: comments });
                ctx.note('proxy-ssl-secret', 'NGINX Ingress Controller reads tls.crt and tls.key' + (verify ? ', and ca.crt for trustedCertSecret,' : '') + ' from the same Secret the community controller did, in the Policy\'s namespace' + (/\//.test(raw) ? ' (the namespace prefix was dropped)' : '') + '.');
                ctx.note('proxy-ssl-secret', 'The upstream connection must already be TLS: set backend-protocol HTTPS (or GRPCS), which this tool turns into ssl-services / upstream tls.');
            },

            // limit-* → a rateLimit Policy (CRD-first) or nginx.org/limit-req-*
            // annotations (annotation-first, because a rateLimit Policy cannot be
            // referenced from an Ingress). Community burst = rate × multiplier,
            // and it always rendered nodelay and rejected with 503.
            generateRateLimitPolicy: function(a, f, ctx) {
                ctx.use('limit-rps', 'limit-rpm', 'limit-burst-multiplier', 'limit-connections', 'limit-rate', 'limit-rate-after', 'limit-whitelist');
                let mult = a['limit-burst-multiplier'] ? communityInt(a, 'limit-burst-multiplier', ctx) : 5;
                if (mult === null) mult = 5;
                let rates = [];
                if (a['limit-rps']) rates.push({ n: communityInt(a, 'limit-rps', ctx, true), unit: 'r/s', src: 'limit-rps' });
                if (a['limit-rpm']) rates.push({ n: communityInt(a, 'limit-rpm', ctx, true), unit: 'r/m', src: 'limit-rpm' });
                rates = rates.filter(function(r) { return r.n !== null && r.n > 0; });
                let rateSet = rates.length > 0;
                // The community template wrote burst=<rate × multiplier> as given:
                // 0 is NGINX's own default (and NGINX Ingress Controller rejects a
                // burst of 0, so it is left out); a negative burst fails nginx -t,
                // so the community controller rejected the Ingress.
                if (rates.length && mult < 0) {
                    ctx.note('limit-burst-multiplier', 'limit-burst-multiplier ' + mult + ' made the community controller write a negative burst, which NGINX refuses, so it rejected this Ingress. Fix the value before migrating; ' + rates.map(function(r) { return r.src; }).join(' and ') + (rates.length > 1 ? ' are' : ' is') + ' not migrated.', 'warning');
                    rates = [];
                } else if (rates.length && mult === 0) {
                    ctx.note('limit-burst-multiplier', 'limit-burst-multiplier 0 gave the community controller burst=0, which is NGINX\'s default; burst is left out, since NGINX Ingress Controller rejects 0.');
                }
                let burst = function(r) { return r.n * mult || null; };
                let allow = commaList(a['limit-whitelist']);
                if (rates.length && ctx.strategy === 'annotation') {
                    let r = rates[0];
                    f.ann['nginx.org/limit-req-rate'] = r.n + r.unit; ctx.annComment('nginx.org/limit-req-rate', r.src);
                    if (burst(r)) { f.ann['nginx.org/limit-req-burst'] = String(burst(r)); ctx.annComment('nginx.org/limit-req-burst', r.src + ' × limit-burst-multiplier (' + mult + ')'); }
                    f.ann['nginx.org/limit-req-no-delay'] = 'true'; ctx.annComment('nginx.org/limit-req-no-delay', 'the community controller always used nodelay');
                    f.ann['nginx.org/limit-req-reject-code'] = '503'; ctx.annComment('nginx.org/limit-req-reject-code', 'the community limit-req-status-code default');
                    if (rates.length > 1) ctx.note('limit-rpm', 'NGINX Ingress Controller takes one limit-req-rate per Ingress; ' + rates[1].src + ' is not migrated. CRD-first emits one rateLimit Policy per rate.', 'warning');
                } else if (rates.length) {
                    rates.forEach(function(r) {
                        let spec = { rate: r.n + r.unit, burst: burst(r), noDelay: true, key: '${binary_remote_addr}', zoneSize: '10M', rejectCode: 503 };
                        if (!spec.burst) delete spec.burst;
                        f.policies.push({ name: ctx.name('rate-limit' + (rates.length > 1 ? '-' + r.unit.replace('r/', 'r') : '')), onIngress: false,
                            spec: { rateLimit: spec },
                            comments: { 'spec.rateLimit.rate': r.src, 'spec.rateLimit.burst': r.src + ' × limit-burst-multiplier (' + mult + ')', 'spec.rateLimit.noDelay': 'the community controller always used nodelay', 'spec.rateLimit.rejectCode': 'the community limit-req-status-code default' } });
                    });
                }
                if (allow.length && rates.length) ctx.note('limit-whitelist', 'NGINX Ingress Controller has no rate-limit exemption list. To keep ' + allow.join(', ') + ' unlimited, set the rateLimit key from a geo map (ConfigMap http-snippets) that yields an empty key for them — NGINX does not count an empty key.', 'warning');
                else if (allow.length) ctx.note('limit-whitelist', 'limit-whitelist only exempts addresses from limit-rps / limit-rpm / limit-connections, and none is set; nothing to migrate.');
                if (a['limit-burst-multiplier'] && !rateSet && !a['limit-connections']) ctx.note('limit-burst-multiplier', 'limit-burst-multiplier only scales limit-rps / limit-rpm / limit-connections, and none is set; nothing to migrate.');
                // limit_conn needs a zone defined in the http context, which only
                // the ConfigMap can add; without it NGINX refuses the config.
                if (a['limit-connections']) {
                    let conn = communityInt(a, 'limit-connections', ctx, true);
                    if (conn !== null && conn > 0) {
                        f.http.push('limit_conn_zone $binary_remote_addr zone=' + ctx.zone('conn') + ':5m;');
                        f.location.push('limit_conn ' + ctx.zone('conn') + ' ' + conn + ';');
                        f.location.push('limit_conn_status 503;');
                        ctx.snippetSource('limit_conn ', 'limit-connections');
                        ctx.snippetSource('limit_conn_status', 'the community limit-conn-status-code default');
                        ctx.snippetSource('limit_conn_zone', 'limit-connections (zone for the location snippet)');
                    }
                }
                let rate = a['limit-rate'] ? communityInt(a, 'limit-rate', ctx) : null;
                let rateAfter = a['limit-rate-after'] ? communityInt(a, 'limit-rate-after', ctx) : null;
                if (rate !== null) { f.location.push('limit_rate ' + rate + 'k;'); ctx.snippetSource('limit_rate ', 'limit-rate (KB/s)'); }
                if (rateAfter !== null) { f.location.push('limit_rate_after ' + rateAfter + 'k;'); ctx.snippetSource('limit_rate_after', 'limit-rate-after (KB)'); }
            },

            // canary-* describe a SECOND Ingress that shares the main one's host
            // and path. A canary Ingress on its own cannot be translated: the
            // stable Service is on the other Ingress. With both pasted the
            // assembler pairs them; alone, the stable side stays a TODO.
            generateCanaryVirtualServer: function(a, f, ctx) {
                ctx.use('canary', 'canary-weight', 'canary-weight-total', 'canary-by-header', 'canary-by-header-value', 'canary-by-header-pattern', 'canary-by-cookie');
                if (!(a.canary !== undefined && communityBool(a, 'canary', ctx, 'false'))) {
                    let names = Object.keys(a).filter(function(k) { return /^canary-/.test(k); });
                    ctx.note(names[0] || 'canary', names.join(', ') + ' without canary: "true" ' + (names.length === 1 ? 'is' : 'are') + ' ignored by the community controller; nothing is migrated.');
                    return;
                }
                let weight = parseInt(a['canary-weight'] || '0', 10);
                let total = parseInt(a['canary-weight-total'] || '100', 10);
                if (isNaN(weight) || weight < 0) weight = 0;
                if (isNaN(total) || total <= 0) total = 100;
                let pct = Math.min(100, Math.max(0, Math.round(weight / total * 100)));
                let matches = [];
                if (a['canary-by-header']) {
                    // Value beats pattern; with neither, "always" routes to the canary.
                    let value = a['canary-by-header-value'] || (a['canary-by-header-pattern'] ? '~' + a['canary-by-header-pattern'] : 'always');
                    matches.push({ conditions: [{ header: a['canary-by-header'], value: value }], action: { pass: '__canary__' } });
                    if (!a['canary-by-header-value'] && !a['canary-by-header-pattern']) ctx.note('canary-by-header', 'The community controller also sent requests with this header set to "never" to the stable backend even under a weight; NGINX Ingress Controller matches only "always" here.');
                }
                if (a['canary-by-cookie']) matches.push({ conditions: [{ cookie: a['canary-by-cookie'], value: 'always' }], action: { pass: '__canary__' } });
                f.canary = { weight: pct, rounded: (weight / total * 100) !== pct ? weight + '/' + total : null, matches: matches, weightSet: a['canary-weight'] !== undefined,
                    matchSources: ['canary-by-header', 'canary-by-header-value', 'canary-by-header-pattern', 'canary-by-cookie'].filter(function(k) { return a[k] !== undefined; }).join(' + '),
                    splitSources: ['canary-weight', 'canary-weight-total'].filter(function(k) { return a[k] !== undefined; }).join(' / ') || 'canary-weight' };
            },

            // redirect.go Parse (controller-v1.15.1), in its order: from-to-www-
            // redirect, then temporal-redirect, which wins and is returned
            // before permanent-redirect is read; a code outside 300-307 (308
            // for permanent) became 302 (301). An invalid bool or code returns
            // its ValidationError, so the community controller rejected the
            // Ingress, even with the code's URL unset.
            generateRedirectVirtualServer: function(a, f, ctx) {
                ctx.use('permanent-redirect', 'permanent-redirect-code', 'temporal-redirect', 'temporal-redirect-code', 'from-to-www-redirect');
                let www = a['from-to-www-redirect'] !== undefined ? communityBool(a, 'from-to-www-redirect', ctx, 'rejects') : undefined;
                let temporal = !!a['temporal-redirect'];
                let kind = temporal ? 'temporal' : 'permanent';
                let codeSrc = kind + '-redirect-code';
                let fallback = temporal ? 302 : 301;
                let code = fallback;
                let codeOk = true;
                if (a[codeSrc] !== undefined) {
                    let n = communityInt(a, codeSrc, ctx, true);
                    codeOk = n !== null;
                    if (n !== null && (n < 300 || n > (temporal ? 307 : 308))) ctx.note(codeSrc, codeSrc + ' ' + n + ' is outside 300-' + (temporal ? 307 : 308) + ', so the community controller used ' + fallback + '; it migrates as ' + fallback + '.');
                    else if (n !== null) code = n;
                }
                let other = temporal ? 'permanent-redirect-code' : 'temporal-redirect-code';
                if (a[other] !== undefined) ctx.note(other, other + ' applies only to ' + other.replace('-code', '') + (temporal ? ', which temporal-redirect overrides' : ', which is not set') + '; the community controller ignored it.');
                let url = a[kind + '-redirect'];
                if (url) {
                    if ([301, 302, 307, 308].indexOf(code) === -1) { ctx.note(codeSrc, 'NGINX Ingress Controller accepts only 301, 302, 307 and 308; using ' + fallback + '.', 'warning'); code = fallback; }
                    let target = braceVariables(url);
                    if (!/:\/\//.test(target)) { target = '${scheme}://${host}' + (target[0] === '/' ? '' : '/') + target; ctx.note(kind + '-redirect', 'NGINX Ingress Controller requires a scheme in a redirect URL; the relative target was made absolute against the request host.'); }
                    f.redirect = { url: target, code: code, source: kind + '-redirect' + (a[codeSrc] ? ' + ' + codeSrc : '') };
                    if (temporal && a['permanent-redirect']) ctx.note('permanent-redirect', 'temporal-redirect takes precedence, as in the community controller; permanent-redirect is not migrated.');
                } else if (a[codeSrc] !== undefined && codeOk) {
                    ctx.note(codeSrc, codeSrc + ' applies only to ' + kind + '-redirect, which is not set; the community controller ignored it.');
                }
                if (www) f.wwwRedirect = true;
                else if (www === false) ctx.note('from-to-www-redirect', 'from-to-www-redirect is false, the community default; nothing to migrate.');
            },

            // rewrite-target, use-regex, app-root. The community controller makes
            // every path on the host a case-insensitive regex (~*) when either
            // rewrite-target or use-regex is set, and rewrites "(?i)<path>" to the
            // target. app-root is a 302 from "/" only — not a rewrite at all.
            generateRewriteVirtualServer: function(a, f, ctx) {
                ctx.use('rewrite-target', 'use-regex', 'app-root');
                let useRegex = a['use-regex'] !== undefined ? communityBool(a, 'use-regex', ctx, 'false') : undefined;
                let regex = useRegex || (a['rewrite-target'] !== undefined && a['rewrite-target'] !== '');
                if (useRegex === false && !regex && GO_FALSE.test(str(a['use-regex']).trim())) ctx.note('use-regex', 'use-regex is false, the community default; nothing to migrate.');
                if (regex) f.regexPaths = true;
                if (a['rewrite-target'] !== undefined && a['rewrite-target'] !== '') f.rewrite = a['rewrite-target'];
                if (a['app-root']) {
                    if (!/^\//.test(a['app-root'])) ctx.note('app-root', 'app-root must be a path starting with "/".', 'warning');
                    else f.appRoot = a['app-root'];
                }
            },

            generateSessionAffinityVS: function(a, f, ctx) {
                ctx.use('affinity', 'affinity-mode', 'session-cookie-name', 'session-cookie-expires', 'session-cookie-max-age', 'session-cookie-path', 'session-cookie-domain', 'session-cookie-secure', 'session-cookie-samesite', 'session-cookie-conditional-samesite-none', 'session-cookie-change-on-failure');
                if (a.affinity === undefined) {
                    // session-cookie-* alone: the community controller read them only under affinity: cookie.
                    let set = Object.keys(a).filter(function(k) { return /^session-cookie-|^affinity-mode$/.test(k); });
                    ctx.note(set[0], set.join(', ') + ' without affinity: "cookie" set nothing in the community controller, so nothing was migrated.');
                    return;
                }
                if (a.affinity !== 'cookie') {
                    ctx.note('affinity', 'The community controller supports only affinity "cookie"; "' + a.affinity + '" set nothing.');
                    return;
                }
                let cookie = { enable: true, name: a['session-cookie-name'] || 'INGRESSCOOKIE' };
                let comments = { 'sessionCookie.name': a['session-cookie-name'] ? 'session-cookie-name' : 'session-cookie-name (community default INGRESSCOOKIE)' };
                // max-age wins over expires in browsers; NGINX sticky sets Expires.
                let secs = parseInt(a['session-cookie-max-age'] || a['session-cookie-expires'] || '', 10);
                if (!isNaN(secs) && secs > 0) { cookie.expires = secondsToNginx(secs); comments['sessionCookie.expires'] = a['session-cookie-max-age'] ? 'session-cookie-max-age' : 'session-cookie-expires'; }
                if (a['session-cookie-path']) { cookie.path = a['session-cookie-path']; comments['sessionCookie.path'] = 'session-cookie-path'; }
                else if (f.regexPaths) { cookie.path = '/'; comments['sessionCookie.path'] = 'session-cookie-path — required with regex paths'; }
                if (a['session-cookie-domain']) { cookie.domain = a['session-cookie-domain']; comments['sessionCookie.domain'] = 'session-cookie-domain'; }
                cookie.httpOnly = true; comments['sessionCookie.httpOnly'] = 'the community controller always set HttpOnly';
                if (a['session-cookie-secure'] !== undefined) { cookie.secure = communityBool(a, 'session-cookie-secure', ctx, 'false'); comments['sessionCookie.secure'] = 'session-cookie-secure'; }
                if (a['session-cookie-samesite']) { cookie.samesite = String(a['session-cookie-samesite']).toLowerCase(); comments['sessionCookie.samesite'] = 'session-cookie-samesite'; }
                if (a['affinity-mode'] === 'persistent') ctx.note('affinity-mode', 'NGINX sticky cookies never rebalance existing sessions, which matches persistent; balanced (the community default) also shifted sessions when Pods scaled, and has no NGINX Ingress Controller equivalent.');
                if (a['session-cookie-change-on-failure'] !== undefined && communityBool(a, 'session-cookie-change-on-failure', ctx, 'false')) ctx.note('session-cookie-change-on-failure', 'NGINX re-picks a server when the bound one fails without rewriting the cookie until the next response — close to, not the same as, what the community controller did.');
                if (a['session-cookie-conditional-samesite-none'] !== undefined && communityBool(a, 'session-cookie-conditional-samesite-none', ctx, 'false')) ctx.note('session-cookie-conditional-samesite-none', 'NGINX cannot drop SameSite=None for incompatible browsers; samesite is applied to every client.');
                if (a['session-cookie-max-age'] && a['session-cookie-expires'] && a['session-cookie-max-age'] !== a['session-cookie-expires']) ctx.note('session-cookie-expires', 'NGINX sets one expiry; session-cookie-max-age was used.');
                f.upstream.sessionCookie = cookie;
                f.upstreamComments = Object.assign(f.upstreamComments || {}, comments);
                f.sticky = cookie;
            },

            // auth-url and friends → externalAuth. NIC proxies the auth request to
            // a Service, so the URL has to name one; an auth server outside the
            // cluster needs an ExternalName Service, which only NGINX Plus resolves.
            generateExternalAuthPolicy: function(a, f, ctx) {
                let own = ['auth-url', 'auth-signin', 'auth-snippet', 'auth-method', 'auth-response-headers', 'auth-request-redirect', 'auth-signin-redirect-param', 'auth-cache-key', 'auth-cache-duration', 'auth-proxy-set-headers'];
                ctx.use.apply(null, own);
                let u = serviceFromURL(a['auth-url']);
                let spec = {};
                let comments = {};
                if (!u && a['auth-url'] === undefined) {
                    // authreq Parse returns ErrMissingAnnotations without it.
                    let set = own.filter(function(k) { return a[k] !== undefined; });
                    ctx.note('auth-url', 'No auth-url, so the community controller ignored ' + set.join(', ') + '; nothing is migrated.');
                    return;
                }
                if (!u) {
                    ctx.note('auth-url', 'auth-url is not an http(s) URL, so no externalAuth Policy can be built from it.', 'warning');
                    return;
                }
                // An invalid auth-always-set-cookie fails the whole authreq Parse
                // with a wrapped error Extract does not classify, so it skips the
                // parser: the community controller served this Ingress with no
                // external auth at all.
                let setCookie = false;
                if (a['auth-always-set-cookie'] !== undefined) {
                    let s = str(a['auth-always-set-cookie']).trim();
                    if (GO_TRUE.test(s)) setCookie = true;
                    else if (!GO_FALSE.test(s)) {
                        ctx.note('auth-always-set-cookie', 'auth-always-set-cookie "' + s + '" is not a boolean, so the community controller dropped external auth for this Ingress (auth-url included) and served it unauthenticated. No externalAuth Policy is migrated: fix the value, then migrate it.', 'warning');
                        return;
                    }
                }
                spec.authURI = u.path || '/';
                comments['spec.externalAuth.authURI'] = 'auth-url (path)';
                if (u.query) ctx.note('auth-url', 'externalAuth.authURI is a path only; the query string ' + u.query + ' is dropped. Move it into authSnippets if the auth server needs it.');
                if (u.external || !u.service || /\$/.test(u.host)) {
                    spec.authServiceName = 'auth-svc';
                    // NIC resolves an ExternalName Service only on NGINX Plus
                    // (v5.6.3 and v5.7.0 getEndpointsForIngressBackend), auth Service included.
                    ctx.todo('spec.externalAuth.authServiceName', 'NGINX Ingress Controller sends the auth request to a Service in the cluster; ' + u.host + ' is not one. Run the auth service in the cluster and name its Service here (an ExternalName Service in front of ' + u.host + ' works only on NGINX Plus)');
                } else {
                    spec.authServiceName = (u.namespace && u.namespace !== ctx.namespace ? u.namespace + '/' : '') + u.service;
                }
                comments['spec.externalAuth.authServiceName'] = 'auth-url (service)';
                if (u.port && u.port !== (u.scheme === 'https' ? 443 : 80)) { spec.authServicePorts = [u.port]; comments['spec.externalAuth.authServicePorts'] = 'auth-url (port)'; }
                if (u.scheme === 'https') { spec.sslEnabled = true; comments['spec.externalAuth.sslEnabled'] = 'auth-url (https)'; }
                if (a['auth-signin']) {
                    let s = serviceFromURL(a['auth-signin']);
                    let path = s ? (s.path || '/') : String(a['auth-signin']).split('?')[0];
                    if (path[0] !== '/') path = '/' + path;
                    spec.authSigninURI = path;
                    comments['spec.externalAuth.authSigninURI'] = 'auth-signin (path only — authSigninURI is relative)';
                    // NIC serves the sign-in from the auth Service at a location of
                    // its own, authSigninRedirectBasePath (default /oauth2), and
                    // sends a 401 to authSigninURI, so the URI must sit under it.
                    // Its parent directory keeps /oauth2/start's /oauth2/callback
                    // there too; a top-level /login is its own base. "/" would
                    // duplicate the route's location "/" and fail the reload.
                    let base = path.replace(/\/[^/]*$/, '') || (path !== '/' ? path : null);
                    if (!base) ctx.note('auth-signin', 'The sign-in path is "/", which NGINX Ingress Controller would have to serve from the auth Service instead of the application. Give the sign-in endpoint a path of its own (oauth2-proxy uses /oauth2/start).', 'warning');
                    else if (base !== '/oauth2') { spec.authSigninRedirectBasePath = base; comments['spec.externalAuth.authSigninRedirectBasePath'] = 'auth-signin (NGINX Ingress Controller serves this path from the auth Service)'; }
                    let clash = base && !f.regexPaths && (ctx.model && ctx.model.hosts || []).some(function(h) { return h.paths.some(function(p) { return p.pathType !== 'Exact' && p.path === base; }); });
                    if (clash) ctx.note('auth-signin', 'NGINX Ingress Controller adds a location at ' + base + ' for the sign-in, and this Ingress already routes ' + base + ': NGINX rejects the duplicate location. Move the sign-in endpoint under a path of its own.', 'warning');
                    if (s && s.query) ctx.note('auth-signin', 'authSigninURI is a path; the query ' + s.query + ' is not carried over. NGINX Ingress Controller appends nothing either, so the sign-in endpoint redirects back using X-Auth-Request-Redirect, which NGINX Ingress Controller sets to $request_uri.');
                    // `$host` (or the Ingress's own host) is this host; only a
                    // different host is lost by reducing the URL to its path.
                    if (s && s.external && !/^\$/.test(s.host) && s.host !== (ctx.host || '')) ctx.note('auth-signin', 'authSigninURI is a path on this host; a sign-in page on ' + s.host + ' cannot be expressed, so NGINX Ingress Controller serves the sign-in path from the auth service on this host instead.', 'warning');
                }
                if (a['auth-snippet']) { spec.authSnippets = a['auth-snippet'].replace(/\n?$/, '\n'); comments['spec.externalAuth.authSnippets'] = 'auth-snippet'; }
                if (a['auth-method']) {
                    spec.authSnippets = (spec.authSnippets || '') + 'proxy_method ' + sanitizeSnippetValue(a['auth-method']) + ';\n';
                    comments['spec.externalAuth.authSnippets'] = (comments['spec.externalAuth.authSnippets'] ? comments['spec.externalAuth.authSnippets'] + ' + ' : '') + 'auth-method';
                }
                if (a['auth-request-redirect']) ctx.note('auth-request-redirect', 'NGINX Ingress Controller always sends X-Auth-Request-Redirect: $request_uri to the sign-in location; a custom value cannot be set.');
                if (a['auth-signin-redirect-param']) ctx.note('auth-signin-redirect-param', 'NGINX Ingress Controller does not append a redirect parameter to authSigninURI; the auth server reads X-Auth-Request-Redirect instead.');
                if (a['auth-cache-key'] || a['auth-cache-duration']) ctx.note(a['auth-cache-key'] ? 'auth-cache-key' : 'auth-cache-duration', 'NGINX Ingress Controller does not cache external auth responses; every request is checked.');
                if (a['auth-proxy-set-headers']) ctx.note('auth-proxy-set-headers', 'Headers from ConfigMap ' + a['auth-proxy-set-headers'] + ' must be copied into authSnippets as proxy_set_header lines.', 'warning');
                if (a['auth-response-headers']) {
                    // auth_request_set lives in the PROTECTED location: authSnippets
                    // land in the internal auth location, where they cannot reach it.
                    commaList(a['auth-response-headers']).forEach(function(h) {
                        let v = 'auth_' + h.toLowerCase().replace(/[^a-z0-9]/g, '_');
                        f.location.push('auth_request_set $' + v + ' $upstream_http_' + h.toLowerCase().replace(/-/g, '_') + ';');
                        f.location.push('proxy_set_header ' + h + ' $' + v + ';');
                    });
                    commaList(a['auth-response-headers']).forEach(function(h) {
                        ctx.snippetSource('auth_request_set $auth_' + h.toLowerCase().replace(/[^a-z0-9]/g, '_') + ' ', 'auth-response-headers');
                        ctx.snippetSource('proxy_set_header ' + h + ' ', 'auth-response-headers');
                    });
                }
                // The community controller passed the auth server's Set-Cookie on
                // to the client, with `always` (every status, not just 2xx/3xx)
                // under auth-always-set-cookie. NIC's auth_request passes none
                // (v5.6.3 and v5.7.0, OSS and Plus templates). Copying it takes snippets, which NIC
                // disables by default, so only the annotation that asks for the
                // cookie gets them; otherwise a note says how.
                if (setCookie) {
                    f.location.push('auth_request_set $auth_cookie $upstream_http_set_cookie;');
                    f.location.push('add_header Set-Cookie $auth_cookie always;');
                    ctx.snippetSource('auth_request_set $auth_cookie ', 'auth-always-set-cookie');
                    ctx.snippetSource('add_header Set-Cookie ', 'auth-always-set-cookie (always: with every response status)');
                } else {
                    ctx.note('auth-url', 'The community controller passed any Set-Cookie from the auth response on to the client; NGINX Ingress Controller does not. If your auth server sets or refreshes a cookie there (oauth2-proxy does with --cookie-refresh), add auth_request_set $auth_cookie $upstream_http_set_cookie; and add_header Set-Cookie $auth_cookie; as location snippets.');
                }
                f.policies.push({ name: ctx.name('external-auth'), spec: { externalAuth: spec }, onIngress: true, comments: comments });
            },

            // Thirteen upstream settings (timeouts, buffers, body sizes, lb-method,
            // keepalive, use-cluster-ip, backend-protocol): one field each on
            // every upstream under CRD-first, an nginx.org/* annotation each
            // under annotation-first. Each mapping names its field (vsField).
            generateUpstreamSettingsVS: function(a, f, ctx, entry) {
                translateValueEntry(entry, f, ctx, ctx.model, ctx.strategy, ctx.allFound || entry.found);
            },

            // Kept from the CRD-first-only generators: each now writes fragments.
            // mirror-* → a mirror directive on the route plus the internal
            // location it points at, as the community controller generated
            // (template.go buildMirrorLocations): Host defaults to the target's
            // host, and the body is mirrored unless mirror-request-body is off.
            generateMirrorSnippets: function(a, f, ctx) {
                ctx.use('mirror-target', 'mirror-host', 'mirror-request-body');
                let target = str(a['mirror-target']).trim();
                if (!target) {
                    let set = ['mirror-host', 'mirror-request-body'].filter(function(k) { return a[k] !== undefined; });
                    ctx.note('mirror-target', 'No mirror-target, so the community controller mirrored nothing' + (set.length ? ' and ignored ' + set.join(', ') : '') + '.');
                    return;
                }
                let host = str(a['mirror-host']).trim();
                if (!host) {
                    let m = target.split('$')[0].match(/^[a-z]+:\/\/([^\/:?#]+)/i);
                    host = m ? m[1] : '';
                }
                let loc = '/_mirror-' + dnsName(ctx.model && ctx.model.name ? ctx.model.name : 'app');
                f.location.push('mirror ' + loc + ';');
                f.location.push('mirror_request_body ' + (str(a['mirror-request-body']).trim() === 'off' ? 'off' : 'on') + ';');
                ctx.snippetSource('mirror ', 'mirror-target');
                ctx.snippetSource('mirror_request_body', a['mirror-request-body'] !== undefined ? 'mirror-request-body' : 'mirror-request-body (community default on)');
                f.server.push('location = ' + loc + ' {');
                f.server.push('    internal;');
                if (host) f.server.push('    proxy_set_header Host ' + sanitizeSnippetValue(host) + ';');
                f.server.push('    proxy_pass ' + sanitizeSnippetValue(target) + ';');
                f.server.push('}');
                ctx.snippetSource('location = ' + loc, 'mirror-target' + (a['mirror-host'] ? ' + mirror-host' : ''));
                // Any variable in a proxy_pass URL makes NGINX resolve its
                // hostname per request, which needs a resolver (verified on
                // nginx 1.29: "no resolver defined to resolve example.org" for
                // http://example.org$request_uri). An IP address needs none.
                let hostPart = ((target.split('://')[1] || '').match(/^[^\/?#:$]*/) || [''])[0];
                // The community controller always configured one; NIC does not,
                // and its resolver-addresses ConfigMap key is NGINX Plus only.
                if (/\$/.test(target) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(hostPart)) ctx.note('mirror-target', 'The target has NGINX variables, so NGINX resolves ' + (hostPart || 'its host') + ' per request and needs a resolver, which NGINX Ingress Controller does not configure: add a resolver line (your cluster DNS) to the server snippet, or the mirror requests fail. On NGINX Plus, the resolver-addresses ConfigMap key also works.', 'warning');
            },

            // The community controller held keepalive connections open to the
            // external-auth backend. NIC has no setting for the auth Service
            // alone (v5.6.3, v5.7.0): a VirtualServer's auth location sends Connection:
            // close, and an Ingress's auth upstream shares nginx.org/keepalive
            // with every other upstream.
            generateAuthKeepaliveNote: function(a, f, ctx) {
                let names = ['auth-keepalive', 'auth-keepalive-requests', 'auth-keepalive-share-vars', 'auth-keepalive-timeout'].filter(function(k) { return a[k] !== undefined; });
                ctx.use.apply(null, names);
                let how = ctx.strategy === 'crd'
                    ? 'a VirtualServer opens a new connection to the auth Service for each check'
                    : 'the Ingress\'s auth Service shares nginx.org/keepalive (or the ConfigMap\'s keepalive) with every other upstream';
                ctx.note(names[0], names.join(', ') + ': NGINX Ingress Controller has no keepalive setting for the external-auth Service alone, so ' + (names.length === 1 ? 'this has' : 'these have') + ' no equivalent: ' + how + '. Size the auth Service for the extra connections.');
            },

            // auth-always-set-cookie belongs to auth-url: generateExternalAuthPolicy
            // writes its snippet. Alone, the community controller ignored it.
            generateAuthCookieNote: function(a, f, ctx) {
                ctx.use('auth-always-set-cookie');
                if (a['auth-url'] === undefined) ctx.note('auth-always-set-cookie', 'Without auth-url this did nothing, so there is nothing to migrate.');
            },

            // NIC traces globally (v5.7.0 has no per-Ingress switch), and only
            // with an exporter: otel-trace-in-http without otel-exporter-endpoint
            // makes NIC report the ConfigMap invalid and leave tracing off.
            // The community controller propagated trace context on every traced
            // location (opentelemetry_propagate) and trusted incoming spans
            // unless opentelemetry-trust-incoming-span was false. NIC's
            // otel-trace-context defaults to ignore, so it is set: propagate to
            // keep that, inject to start a new trace instead of trusting one.
            generateOtelConfigMap: function(a, f, ctx) {
                ctx.use('enable-opentelemetry', 'opentelemetry-trust-incoming-span');
                if (a['enable-opentelemetry'] === undefined) {
                    ctx.note('opentelemetry-trust-incoming-span', 'Without enable-opentelemetry on this Ingress, this applied only where the community ConfigMap turned tracing on. In NGINX Ingress Controller, set otel-trace-context in the nginx-config ConfigMap: propagate to trust incoming spans, inject to start a new trace. It is global, not per Ingress.');
                    return;
                }
                if (!(a['enable-opentelemetry'] !== undefined && communityBool(a, 'enable-opentelemetry', ctx, 'false'))) { ctx.note('enable-opentelemetry', 'This opted the Ingress out of tracing. NGINX Ingress Controller traces all requests or none (otel-trace-in-http), so there is no per-Ingress opt-out; tracing is off by default in NGINX Ingress Controller, so nothing is needed.'); return; }
                f.cm['otel-trace-in-http'] = 'true';
                f.cmComments['otel-trace-in-http'] = 'enable-opentelemetry';
                f.cm['otel-exporter-endpoint'] = 'otel-collector:4317';
                f.cmComments['otel-exporter-endpoint'] = 'TODO: your collector — NGINX Ingress Controller keeps tracing off without it (the community controller read otlp-collector-host, port 4317)';
                ctx.todo('data.otel-exporter-endpoint', 'the OpenTelemetry collector address (host:port), which NGINX Ingress Controller requires before tracing anything');
                f.cm['otel-service-name'] = 'nginx';
                f.cmComments['otel-service-name'] = 'the community default service name';
                let trust = a['opentelemetry-trust-incoming-span'] === undefined || communityBool(a, 'opentelemetry-trust-incoming-span', ctx, 'false');
                f.cm['otel-trace-context'] = trust ? 'propagate' : 'inject';
                f.cmComments['otel-trace-context'] = trust
                    ? (a['opentelemetry-trust-incoming-span'] === undefined ? 'the community controller propagated trace context (NGINX Ingress Controller defaults to ignore)' : 'opentelemetry-trust-incoming-span')
                    : 'opentelemetry-trust-incoming-span: false — a new trace, passed on';
                if (a['opentelemetry-trust-incoming-span'] !== undefined) ctx.note('opentelemetry-trust-incoming-span', 'otel-trace-context is global in NGINX Ingress Controller: it applies to every Ingress and VirtualServer, not just this one.');
                ctx.note('enable-opentelemetry', 'NGINX Ingress Controller traces every request once otel-trace-in-http is on: there is no per-Ingress switch, so this applies to all Ingresses and VirtualServers.');
            },

            // affinity-canary-behavior chose whether a canary request carrying a
            // session cookie stayed on the canary ("sticky", the default) or
            // ignored affinity ("legacy"). A VirtualServer split is evaluated
            // per request and sessionCookie applies within one upstream, so a
            // client can cross between stable and canary either way.
            generateCanaryAffinityNote: function(a, f, ctx) {
                ctx.use('affinity-canary-behavior');
                ctx.note('affinity-canary-behavior', 'No equivalent: NGINX Ingress Controller picks the split for every request, and sessionCookie keeps a client on one Pod within the chosen upstream, not on the canary. To pin a client to the canary, route it with a cookie or header match (canary-by-cookie / canary-by-header).');
            },

            generateHashLBVirtualServer: function(a, f, ctx) {
                ctx.use('upstream-hash-by', 'upstream-hash-by-subset', 'upstream-hash-by-subset-size');
                let by = String(a['upstream-hash-by'] || '').trim();
                // upstreamhashby Parse reads all three, returning an invalid
                // one's ValidationError, but the balancer uses the subset only
                // with upstream-hash-by set.
                let subset = a['upstream-hash-by-subset'] !== undefined ? communityBool(a, 'upstream-hash-by-subset', ctx, 'rejects') : undefined;
                let size = a['upstream-hash-by-subset-size'] !== undefined ? communityInt(a, 'upstream-hash-by-subset-size', ctx, true) : undefined;
                if (!by) {
                    let valid = { 'upstream-hash-by-subset': subset !== undefined && (GO_TRUE.test(str(a['upstream-hash-by-subset']).trim()) || GO_FALSE.test(str(a['upstream-hash-by-subset']).trim())), 'upstream-hash-by-subset-size': size !== undefined && size !== null };
                    let set = Object.keys(valid).filter(function(k) { return valid[k]; });
                    if (set.length) ctx.note(set[0], set.join(' and ') + (set.length > 1 ? ' only apply' : ' only applies') + ' with upstream-hash-by, which is not set; the community controller ignored ' + (set.length > 1 ? 'them' : 'it') + '.');
                    return;
                }
                if (subset) ctx.note('upstream-hash-by-subset', 'NGINX Ingress Controller has no subset hashing; the whole upstream is hashed consistently.');
                if (size !== undefined && size !== null) ctx.note('upstream-hash-by-subset-size', 'No NGINX Ingress Controller equivalent: only the community controller has subset hashing.');
                let method = 'hash ' + braceVariables(by).replace(/^\$\{([^}]+)\}$/, '$$$1') + ' consistent';
                f.upstream['lb-method'] = method; f.upstreamComments['lb-method'] = 'upstream-hash-by';
                f.ann['nginx.org/lb-method'] = method; ctx.annComment('nginx.org/lb-method', 'upstream-hash-by'); ctx.annCovered('nginx.org/lb-method');
            },

            generateProxyNextUpstreamVS: function(a, f, ctx) {
                ctx.use('proxy-next-upstream', 'proxy-next-upstream-timeout', 'proxy-next-upstream-tries');
                if (a['proxy-next-upstream']) {
                    f.upstream['next-upstream'] = a['proxy-next-upstream']; f.upstreamComments['next-upstream'] = 'proxy-next-upstream';
                    f.ann['nginx.org/proxy-next-upstream'] = a['proxy-next-upstream']; ctx.annComment('nginx.org/proxy-next-upstream', 'proxy-next-upstream'); ctx.annCovered('nginx.org/proxy-next-upstream');
                }
                if (a['proxy-next-upstream-timeout']) {
                    f.upstream['next-upstream-timeout'] = nicDuration(a['proxy-next-upstream-timeout']); f.upstreamComments['next-upstream-timeout'] = 'proxy-next-upstream-timeout';
                    f.ann['nginx.org/proxy-next-upstream-timeout'] = nicDuration(a['proxy-next-upstream-timeout']); ctx.annComment('nginx.org/proxy-next-upstream-timeout', 'proxy-next-upstream-timeout'); ctx.annCovered('nginx.org/proxy-next-upstream-timeout');
                }
                let tries = a['proxy-next-upstream-tries'] ? communityInt(a, 'proxy-next-upstream-tries', ctx) : null;
                if (tries !== null) {
                    f.upstream['next-upstream-tries'] = tries; f.upstreamComments['next-upstream-tries'] = 'proxy-next-upstream-tries';
                    f.ann['nginx.org/proxy-next-upstream-tries'] = String(tries); ctx.annComment('nginx.org/proxy-next-upstream-tries', 'proxy-next-upstream-tries'); ctx.annCovered('nginx.org/proxy-next-upstream-tries');
                }
            },

            // The headers live in a ConfigMap the analyzer cannot see, so the
            // output carries one placeholder, marked as such where it stands.
            // more_set_headers sent them with every status; NIC's add_header
            // does that only with `always` (nginx.org/add-header: "Name: value: always").
            generateCustomHeadersVS: function(a, f, ctx) {
                ctx.use('custom-headers');
                f.proxy.responseHeaders = { add: [{ name: 'X-Example-Header', value: 'value', always: true }] };
                f.responseHeaderNote = 'custom-headers — TODO: replace the placeholder with each header in ConfigMap ' + a['custom-headers'];
                ctx.todo('proxy.responseHeaders', 'copy each header from ConfigMap ' + a['custom-headers'] + ' (the community controller sent them with more_set_headers)');
                f.ann['nginx.org/add-header'] = 'X-Example-Header: value: always'; ctx.annCovered('nginx.org/add-header');
                ctx.annComment('nginx.org/add-header', 'custom-headers — TODO: replace the placeholder with each header in ConfigMap ' + a['custom-headers']);
                ctx.note('custom-headers', 'The headers are in ConfigMap ' + a['custom-headers'] + ', which the analyzer cannot read; copy them into the placeholder.', 'warning');
            },

            generateRequestHeadersVS: function(a, f, ctx) {
                ctx.use('upstream-vhost', 'x-forwarded-prefix');
                let set = [];
                if (a['upstream-vhost']) {
                    set.push({ name: 'Host', value: braceVariables(a['upstream-vhost']) });
                    let t = unwrapTranslated(translateValue(a['upstream-vhost'], 'upstreamVhost'));
                    if (t.value !== null) { f.ann['nginx.org/upstream-vhost'] = t.value; ctx.annComment('nginx.org/upstream-vhost', 'upstream-vhost' + (t.note ? ' — ' + t.note : '')); ctx.annCovered('nginx.org/upstream-vhost'); }
                    else ctx.annotationOnlyNote('upstream-vhost', t.note);
                }
                if (a['x-forwarded-prefix']) {
                    if (/\$\d/.test(a['x-forwarded-prefix'])) {
                        set.push({ name: 'X-Forwarded-Prefix', value: '/prefix' });
                        ctx.todo('proxy.requestHeaders', 'X-Forwarded-Prefix — capture groups such as $1 have no VirtualServer equivalent; set a literal prefix');
                    } else {
                        set.push({ name: 'X-Forwarded-Prefix', value: braceVariables(a['x-forwarded-prefix']) });
                    }
                    let t = unwrapTranslated(translateValue(a['x-forwarded-prefix'], 'proxySetHeader', 'X-Forwarded-Prefix: ${value}'));
                    if (t.value !== null) { f.ann['nginx.org/proxy-set-headers'] = t.value; ctx.annComment('nginx.org/proxy-set-headers', 'x-forwarded-prefix'); ctx.annCovered('nginx.org/proxy-set-headers'); }
                    else ctx.annotationOnlyNote('x-forwarded-prefix', t.note);
                }
                if (set.length) {
                    f.proxy.requestHeaders = { set: set };
                    f.requestHeaderSources = ['upstream-vhost', 'x-forwarded-prefix'].filter(function(k) { return a[k]; }).join(' + ');
                }
            },

            generateServerAliasVS: function(a, f, ctx) {
                ctx.use('server-alias');
                let aliases = commaList(a['server-alias']).map(function(h) { return h.toLowerCase(); });
                let bad = aliases.filter(function(h) { return !/^(\*\.)?[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(h); });
                if (bad.length) ctx.note('server-alias', 'Not valid host names, skipped: ' + bad.join(', '), 'warning');
                f.aliases = aliases.filter(function(h) { return bad.indexOf(h) === -1; });
            },

            generateSSLPassthroughTransportServer: function(a, f, ctx) {
                ctx.use('ssl-passthrough');
                let raw = str(a['ssl-passthrough']).trim();
                if (!communityBool(a, 'ssl-passthrough', ctx, 'rejects')) { if (GO_FALSE.test(raw)) ctx.note('ssl-passthrough', 'ssl-passthrough is not "true", so it set nothing.'); return; }
                // TLS passthrough is a TransportServer under both strategies: an
                // Ingress has no form for it in NIC.
                f.passthrough = true;
            },

            generateStreamSnippetTS: function(a, f, ctx) {
                ctx.use('stream-snippet');
                // A stream snippet is raw stream{} configuration; NIC's
                // stream-snippets ConfigMap key is its direct equivalent (and,
                // like http-snippets, does not need -enable-snippets).
                f.cm['stream-snippets'] = String(a['stream-snippet']).replace(/\n?$/, '\n');
                f.cmComments['stream-snippets'] = 'stream-snippet';
                ctx.note('stream-snippet', 'Moved to the stream-snippets ConfigMap key as-is. Its upstreams name Services by DNS, which NGINX resolves once at reload; a TransportServer (with a GlobalConfiguration listener) tracks Pod endpoints instead and is the long-term form.');
            },

            generateErrorPagesVirtualServer: function(a, f, ctx) {
                ctx.use('custom-http-errors', 'default-backend');
                // customhttperrors Parse fails on any entry strconv.Atoi rejects,
                // and Extract skips it: none of the codes took effect.
                let entries = commaList(a['custom-http-errors']);
                let bad = badErrorCodes(a);
                if (bad.length) {
                    ctx.note('custom-http-errors', bad.map(function(c) { return '"' + c + '"'; }).join(', ') + ' ' + (bad.length > 1 ? 'are not status codes' : 'is not a status code') + ', so the community controller ignored custom-http-errors altogether; nothing is migrated.', 'warning');
                    entries = [];
                }
                let codes = entries.map(function(c) { return parseInt(c, 10); });
                let kept = codes.filter(function(c) { return c !== 499 && c >= 300 && c <= 599; });
                if (kept.length < codes.length) ctx.note('custom-http-errors', 'Dropped ' + codes.filter(function(c) { return kept.indexOf(c) === -1; }).join(', ') + ' — NGINX Ingress Controller accepts error pages for 300–599 only, and rejects 499.');
                f.errorCodes = kept;
                // A Service name or nothing: the community controller rejected
                // anything but a DNS-1035 label, and under nic-migrate --kubectl
                // this value reaches kubectl's argv, where "-…" is a flag.
                let backend = String(a['default-backend'] || '').trim();
                if (backend && !/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/.test(backend)) {
                    ctx.note('default-backend', '"' + backend + '" is not a valid Service name, so spec.defaultBackend was not set.', 'warning');
                    backend = '';
                }
                f.defaultBackendService = backend || null;
                if (!kept.length) return;
                if (ctx.strategy === 'annotation') {
                    if (!a['default-backend'] && !ctx.hasDefaultBackend) ctx.note('custom-http-errors', 'NGINX Ingress Controller sends these errors to this Ingress\'s spec.defaultBackend and ignores the annotation without one — the community controller fell back to its global default backend. Set spec.defaultBackend to your error-page Service.', 'warning');
                } else if (a['default-backend']) {
                    ctx.note('default-backend', 'errorPages can only redirect or return a canned body, so the error pages Service ' + a['default-backend'] + ' served are replaced by a minimal body. To keep serving them from the Service, use annotation-first (nginx.org/custom-http-errors).', 'warning');
                }
            }
        };

        // Does CIDR (or address) `outer` contain `inner`? IPv4 only; IPv6 and
        // anything unparsable is treated as "maybe" (true), so the warning errs
        // on the side of telling the user.
        function cidrContains(outer, inner) {
            function parse(c) {
                let m = String(c).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
                if (!m) return null;
                let ip = ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + (+m[4]);
                let bits = m[5] === undefined ? 32 : +m[5];
                return { ip: ip >>> 0, bits: bits };
            }
            let o = parse(outer), i = parse(inner);
            if (!o || !i) return true;
            if (i.bits < o.bits) return false;
            let mask = o.bits === 0 ? 0 : (0xFFFFFFFF << (32 - o.bits)) >>> 0;
            return ((o.ip & mask) >>> 0) === ((i.ip & mask) >>> 0);
        }
        // --- Assembly ----------------------------------------------------------
        // Builds the migrated resources for ONE Ingress from its model and the
        // translators' fragments. The rules this exists to keep:
        //   - NIC lets one resource own a host; Ingress and VirtualServer share
        //     the namespace of hosts. So CRD-first emits exactly one VirtualServer
        //     per host, and annotation-first one migrated Ingress — never both.
        //   - Every route, backend, TLS secret and namespace of the source is
        //     carried over, and every Policy is referenced, not left as a comment.
        //   - Under CRD-first, settings with no VirtualServer field ride on the
        //     VirtualServer (snippets, upstream fields), never on Ingress
        //     annotations that nothing would read.

        // Regex metacharacters that make a community path a regex when
        // use-regex/rewrite-target is on (and which NIC matches literally).
        let PATH_REGEX_CHARS = /[\^$()*+?[\]{}|\\]/;

        // Ingress pathType → VirtualServer route path. The community controller
        // made EVERY path on the host a case-insensitive regex once use-regex or
        // rewrite-target was set, matched as `~* "^<path>"` and rewritten with
        // "(?i)<path>". The route says `~ (?i)^<path>`, not `~* ^<path>`: NIC
        // builds the rewrite from the path minus its modifier, so "~*" would
        // match /API/x and then not rewrite it. Verified on nginx 1.29 against
        // the location and rewrite NIC renders for both forms.
        function vsRoutePath(p, regex) {
            if (regex) return '~ (?i)^' + p.path;
            if (p.pathType === 'Exact') return '=' + p.path;
            return p.path;
        }

        // Does the community rewrite target reference capture group n?
        function captureRefs(target) {
            let refs = [];
            String(target).replace(/\$(\d)/g, function(_, d) { refs.push(+d); return _; });
            return refs;
        }
        function captureCount(re) {
            // Count unescaped "(" that do not open a non-capturing group.
            let n = 0;
            for (let i = 0; i < re.length; i++) {
                if (re[i] === '\\') { i++; continue; }
                if (re[i] === '(' && re[i + 1] !== '?') n++;
            }
            return n;
        }

        function upstreamName(service, port, taken) {
            let base = dnsName(service, 'backend');
            let name = base;
            for (let n = 2; taken[name] && taken[name] !== service + ':' + port; n++) name = base + '-' + n;
            taken[name] = service + ':' + port;
            return name;
        }

        // Normalise a backend's port for a VirtualServer upstream (a number) or
        // report that it is a named port the tool cannot resolve.
        // VirtualServer upstreams take a port NUMBER. A named Service port is
        // kept as written, with a placeholder note: inventing 80 would apply
        // and route to the wrong port, where the name fails validation loudly.
        function upstreamPort(port, ctx, where) {
            if (typeof port === 'number') return port;
            if (/^\d+$/.test(String(port))) return parseInt(port, 10);
            if (port === null || port === undefined || port === '') { ctx.todo(where, 'the Service port (none is set on this backend)'); return 80; }
            ctx.todo(where, 'named Service port "' + port + '" — replace it with the port number; VirtualServer upstreams take numbers');
            return port;
        }

        function makeCtx(model, strategy, plan) {
            let ns = model.namespace;
            let comments = {};
            let usedNames = {};
            let ctx = {
                strategy: strategy,
                namespace: ns,
                host: model.hosts.length ? model.hosts[0].host : null,
                nicVersion: MigrationTool.NIC.VERSION.replace(/^v/, ''),
                hasDefaultBackend: !!model.defaultBackend,
                consumed: {},
                notes: [],
                todos: [],
                snippetSources: [],
                annComments: {},
                use: function() { for (let i = 0; i < arguments.length; i++) ctx.consumed[arguments[i]] = true; },
                note: function(annotation, message, severity) {
                    if (ctx.notes.some(function(n) { return n.annotation === annotation && n.message === message; })) return;
                    ctx.notes.push({ annotation: annotation, message: message, severity: severity || 'note' });
                },
                todo: function(path, message) {
                    if (ctx.todos.some(function(t) { return t.path === path && t.message === message; })) return;
                    ctx.todos.push({ path: path, message: message });
                },
                annComment: function(key, text) { ctx.annComments[key] = text; },
                // An nginx.org/* annotation whose meaning the translator also
                // wrote as a VirtualServer field: CRD-first drops it silently.
                covered: {},
                annCovered: function(key) { ctx.covered[key] = true; },
                snippetSource: function(prefix, text) { ctx.snippetSources.push({ prefix: prefix, text: text }); },
                annotationOnlyNote: function(annotation, message) { if (strategy === 'annotation') ctx.note(annotation, message, 'warning'); },
                name: function(base) {
                    let stem = dnsName((model.name ? model.name + '-' : '') + base);
                    let n = stem;
                    for (let i = 2; usedNames[n]; i++) n = stem + '-' + i;
                    usedNames[n] = true;
                    return n;
                },
                zone: function(kind) { return dnsName((model.namespace ? model.namespace + '_' : '') + (model.name || 'app') + '_' + kind).replace(/-/g, '_'); }
            };
            return ctx;
        }

        // Comment for the snippet line that starts with `prefix`, if a translator recorded one.
        function snippetComment(line, ctx) {
            let hit = ctx.snippetSources.find(function(s) { return line.indexOf(s.prefix) === 0; });
            return hit ? hit.text : null;
        }

        function snippetBlock(lines) { return lines.length ? lines.join('\n') + '\n' : null; }
        // Value-level mappings: a key rename plus a transform. Under CRD-first
        // any that names a VirtualServer field (vsField) becomes that field of
        // every upstream (generateUpstreamSettingsVS); the rest become
        // nginx.org/* annotations, snippet lines or ConfigMap keys.
        function translateValueEntry(entry, f, ctx, model, strategy, allFound) {
            let om = entry.mapping.nicMapping || {};
            entry.found.forEach(function(x) {
                let spec = (om.annotations || {})[x.annotation];
                let cmSpec = (om.configMap || {})[x.annotation];
                if (cmSpec) {
                    ctx.use(x.annotation);
                    let t = unwrapTranslated(translateValue(x.value, cmSpec.transform, cmSpec.template, entry.found));
                    if (t.value === null) { ctx.note(x.annotation, t.note); return; }
                    f.cm[cmSpec.key] = String(t.value);
                    f.cmComments[cmSpec.key] = x.annotation + (t.note ? ' — ' + t.note : '');
                    if (cmSpec.scope) ctx.note(x.annotation, cmSpec.scope);
                    return;
                }
                if (!spec) return;
                ctx.use(x.annotation);
                if (spec.transform === 'backendProtocol') { translateBackendProtocol(x, f, ctx, model); return; }
                if (str(x.value).trim() === '' && spec.transform !== 'defaultBackend') { ctx.note(x.annotation, 'Empty value: the community controller used its default, so nothing is migrated.'); return; }
                let t = unwrapTranslated(translateValue(x.value, spec.transform, spec.template, spec.vsField ? allFound : entry.found));
                if (t.value === null) { ctx.note(x.annotation, t.note, 'warning'); return; }
                if (strategy === 'crd' && spec.vsField) {
                    let v = vsFieldValue(spec.vsField, t.value, x, ctx);
                    if (v === undefined) return;
                    f.upstream[spec.vsField] = v;
                    f.upstreamComments[spec.vsField] = x.annotation + (t.note ? ' — ' + t.note : '');
                    return;
                }
                if (spec.key === 'nginx.org/location-snippets' || spec.key === 'nginx.org/server-snippets') {
                    let body = String(t.value).split('\n').filter(function(l) { return l.trim() !== ''; });
                    body.forEach(function(line) {
                        (spec.key === 'nginx.org/location-snippets' ? f.location : f.server).push(line);
                        ctx.snippetSource(line, x.annotation);
                    });
                    // Directives from modules the community image built in and
                    // NIC's does not: they fail the reload, not just the feature.
                    let foreign = body.join('\n').match(/\b(more_set_headers|more_clear_headers|more_set_input_headers|more_clear_input_headers|[a-z_]+_by_lua(?:_block|_file)?|lua_[a-z_]+|set_by_lua\w*|modsecurity\w*)\b/g);
                    if (foreign) ctx.note(x.annotation, 'Uses ' + foreign.filter(function(d, i) { return foreign.indexOf(d) === i; }).join(', ') + ', which NGINX Ingress Controller does not build in: the reload fails with "unknown directive". Rewrite with add_header / proxy_set_header / proxy_hide_header (or a VirtualServer requestHeaders / responseHeaders block).', 'warning');
                    return;
                }
                if (spec.key === 'spec.defaultBackend') return;
                f.ann[spec.key] = String(t.value);
                ctx.annComment(spec.key, x.annotation + (t.note ? ' — ' + t.note : ''));
            });
        }

        // Translate one Ingress: run every matched mapping, then build resources.
        //   strategy  'crd' | 'annotation'
        //   options   { ingressClass, nameSuffix, canaryStable (model), target }
        // Returns { docs, comments (per doc), notes, todos, swaps, configMap,
        //           consumedBy (annotation → mapping), unmatched, unsupported }.
        function migrateIngress(model, strategy, options) {
            options = options || {};
            let ctx = makeCtx(model, strategy);
            let a = model.community;
            let f = { upstream: {}, upstreamComments: {}, proxy: {}, location: [], server: [], http: [], policies: [], ann: {}, cm: {}, cmComments: {} };
            let matched = new Map();
            let unrecognized = [];
            Object.keys(a).forEach(function(name) {
                let idx = ANNOTATION_LOOKUP.get(name);
                if (idx === undefined) { unrecognized.push(name); return; }
                if (!matched.has(idx)) matched.set(idx, { mapping: ANNOTATION_MAPPINGS[idx], found: [] });
                matched.get(idx).found.push({ annotation: name, value: a[name] });
            });

            let unsupported = [];
            let simple = [];
            matched.forEach(function(entry) {
                let m = entry.mapping;
                let om = m.nicMapping || {};
                if (m.type === 'unsupported') { unsupported.push(entry); entry.found.forEach(function(x) { ctx.consumed[x.annotation] = true; }); return; }
                // Rewrites must run before affinity (it needs to know about regex paths).
                if (om.templateFn && TRANSLATORS[om.templateFn]) entry.translator = om.templateFn;
                else simple.push(entry);
            });
            // What each mapping wrote, so a card shows the annotations behind
            // the resource beside it: a new Policy is the mapping's own; any
            // other change lands in the VirtualServer / migrated Ingress; a
            // mapping that changed nothing only left a note.
            let hostState = function() {
                let c = {};
                Object.keys(f).forEach(function(k) { if (k !== 'policies' && k !== 'cm' && k !== 'cmComments') c[k] = f[k]; });
                return JSON.stringify(c);
            };
            let track = function(entry, run) {
                let h = hostState(), p = f.policies.length, cm = JSON.stringify(f.cm);
                run();
                entry.toHost = hostState() !== h;
                let own = entry.found.map(function(x) { return x.annotation; });
                f.policies.slice(p).forEach(function(pol) { pol.sources = own; });
                entry.toPolicy = f.policies.length > p;
                entry.toConfigMap = JSON.stringify(f.cm) !== cm;
            };
            let order = ['generateRewriteVirtualServer'];
            let entries = Array.from(matched.values()).filter(function(e) { return e.translator; });
            entries.sort(function(x, y) { return (order.indexOf(y.translator) - order.indexOf(x.translator)); });
            // Every annotation found, for transforms that read a sibling from
            // another mapping (proxy-buffers-number takes proxy-buffer-size).
            let allFound = [].concat.apply([], Array.from(matched.values()).map(function(e) { return e.found; }));
            ctx.allFound = allFound;
            ctx.model = model;
            entries.forEach(function(entry) {
                ctx.entry = entry;
                // preferAnnotation (custom-http-errors): the annotation form is the
                // better answer, but CRD-first emits a VirtualServer, which cannot
                // carry it. So CRD-first emits the CRD form and says, as a warning,
                // why annotation-first suits this Ingress better — when there is
                // anything to migrate.
                if (entry.mapping.preferAnnotation && strategy === 'crd' && !options.ignorePreferAnnotation && !(entry.translator === 'generateErrorPagesVirtualServer' && badErrorCodes(a).length)) {
                    ctx.note(entry.found[0].annotation, 'Annotation-first is recommended for this Ingress: ' + entry.mapping.preferAnnotation, 'warning');
                }
                track(entry, function() {
                    try {
                        TRANSLATORS[entry.translator](a, f, ctx, entry);
                    } catch (e) {
                        console.warn('Translator failed for ' + entry.mapping.category + ' (' + entry.translator + '):', e);
                    }
                });
            });

            // Value-level mappings with no translator of their own.
            simple.forEach(function(entry) { track(entry, function() { translateValueEntry(entry, f, ctx, model, strategy, allFound); }); });

            // proxy-buffer-size beside the default buffers: the community sized
            // four buffers with it, and NGINX rejects a large buffer-size alone.
            if (f.upstream['buffer-size'] && !f.upstream.buffers) {
                f.upstream.buffers = { number: 4, size: f.upstream['buffer-size'] };
                f.upstreamComments.buffers = 'proxy-buffer-size — the community controller sized 4 proxy buffers with it';
            }
            if (f.ann['nginx.org/proxy-buffer-size'] && !f.ann['nginx.org/proxy-buffers']) {
                f.ann['nginx.org/proxy-buffers'] = '4 ' + f.ann['nginx.org/proxy-buffer-size'];
                ctx.annComment('nginx.org/proxy-buffers', 'proxy-buffer-size — the community controller sized 4 proxy buffers with it');
            }

            // Whatever a matched entry did not consume is named, not dropped.
            matched.forEach(function(entry) {
                entry.found.forEach(function(x) {
                    if (!ctx.consumed[x.annotation]) ctx.note(x.annotation, 'Recognized, but this tool has no translation for it: migrate it by hand (see the reference row).', 'warning');
                });
            });

            let out = strategy === 'crd' ? buildCrd(model, f, ctx, options) : buildIngress(model, f, ctx, options);

            // Every recognised annotation must be findable in the output: named
            // in a generated comment, a note or a card. Several feed one field
            // (permanent-redirect-code into `code`, session-cookie-* into one
            // sticky-cookie-services value), so those the comments do not name
            // are listed once, rather than leaving the reader to guess.
            let named = {};
            let addNames = function(text) { String(text || '').split(/[^a-z0-9-]+/).forEach(function(w) { if (w) named[w] = true; }); };
            (out.comments || []).forEach(function(c) { Object.keys(c).forEach(function(k) { addNames(c[k]); }); });
            Object.keys(f.cmComments).forEach(function(k) { addNames(f.cmComments[k]); });
            ctx.notes.forEach(function(n) { addNames(n.annotation); });
            ctx.todos.forEach(function(t) { addNames(t.message); });
            // Only a mapping that wrote something folded anything in. One that
            // wrote nothing was either named by a note (enable-cors unset:
            // "ignored cors-allow-origin") or said nothing, which is a lost
            // setting and says so.
            // An empty value skips validation and reads as invalid content, which
            // no parser rejects on: each kept its default or was skipped.
            let unnamed = [], lost = [], empty = [];
            matched.forEach(function(entry) {
                if (entry.mapping.type === 'unsupported') return;
                let wrote = entry.toHost || entry.toPolicy || entry.toConfigMap;
                let explained = function(name) { return ctx.notes.some(function(n) { return new RegExp('(^|[^a-z-])' + name + '($|[^a-z-])').test(n.message); }); };
                entry.found.forEach(function(x) {
                    if (named[x.annotation] || !ctx.consumed[x.annotation]) return;
                    if (wrote) unnamed.push(x.annotation);
                    else if (explained(x.annotation)) return;
                    else if (str(x.value).trim() === '') empty.push(x.annotation);
                    else lost.push(x.annotation);
                });
            });
            if (empty.length) ctx.note('applied', 'Empty, so the community controller ignored ' + (empty.length > 1 ? 'them' : 'it') + ': ' + empty.join(', ') + '. Nothing is migrated.');
            if (unnamed.length && out.docs.length) ctx.note('applied', 'Also applied, folded into the fields above: ' + unnamed.join(', ') + '.');
            else if (unnamed.length) ctx.note('applied', 'Not migrated, because no resource was produced: ' + unnamed.join(', ') + '.', 'warning');
            if (lost.length) ctx.note('applied', 'Recognized but not migrated, and this tool did not say why: ' + lost.join(', ') + '. Check what the community controller did with ' + (lost.length > 1 ? 'these values' : 'this value') + ' (it ignored some values and rejected the Ingress over others) and migrate by hand if it took effect; see the reference rows.', 'warning');

            out.notes = ctx.notes;
            out.todos = ctx.todos;
            out.httpSnippets = f.http.length ? f.http.slice() : null;
            out.unsupported = unsupported;
            out.unrecognized = unrecognized;
            out.matched = matched;
            out.configMap = Object.keys(f.cm).length ? { data: f.cm, comments: f.cmComments } : null;
            // Which community annotations each document answers for, so its
            // card shows those rather than the whole Ingress. A mapping that
            // also made a Policy keeps, here, only the annotations this
            // document's comments name (limit-connections' snippet, not
            // limit-rps' Policy).
            out.sources = out.docs.map(function(d, i) {
                if (d.kind === 'Policy') {
                    let p = f.policies.find(function(x) { return x.name === d.metadata.name; });
                    return p && p.sources ? p.sources.slice() : [];
                }
                let named = {};
                Object.keys(out.comments[i] || {}).forEach(function(k) { String(out.comments[i][k]).split(/[^a-z0-9-]+/).forEach(function(w) { if (w) named[w] = true; }); });
                let keys = [];
                matched.forEach(function(entry) {
                    if (!entry.toHost) return;
                    let own = entry.found.map(function(x) { return x.annotation; });
                    let mine = entry.toPolicy ? own.filter(function(k) { return named[k]; }) : own;
                    (mine.length ? mine : own).forEach(function(k) { if (keys.indexOf(k) === -1) keys.push(k); });
                });
                return Object.keys(a).filter(function(k) { return keys.indexOf(k) !== -1; });
            });
            return out;
        }

        // backend-protocol → upstream type/tls (CRD) or ssl-services /
        // grpc-services (annotation). GRPCS needs BOTH grpc-services and
        // ssl-services, and gRPC needs HTTP/2, which NIC 5.6 enables only
        // through the http2 ConfigMap key.
        function translateBackendProtocol(x, f, ctx, model) {
            let p = String(x.value || '').trim().toUpperCase();
            let services = [];
            model.hosts.forEach(function(h) { h.paths.forEach(function(pp) { if (pp.backend && pp.backend.service && services.indexOf(pp.backend.service) === -1) services.push(pp.backend.service); }); });
            if (model.defaultBackend && model.defaultBackend.service && services.indexOf(model.defaultBackend.service) === -1) services.push(model.defaultBackend.service);
            let list = services.join(',') || 'my-service';
            if (p === 'HTTPS' || p === 'GRPCS') {
                f.upstream.tls = { enable: true }; f.upstreamComments.tls = 'backend-protocol ' + p;
                f.ann['nginx.org/ssl-services'] = list; ctx.annComment('nginx.org/ssl-services', 'backend-protocol ' + p); ctx.annCovered('nginx.org/ssl-services');
            }
            if (p === 'GRPC' || p === 'GRPCS') {
                f.upstream.type = 'grpc'; f.upstreamComments.type = 'backend-protocol ' + p;
                f.ann['nginx.org/grpc-services'] = list; ctx.annComment('nginx.org/grpc-services', 'backend-protocol ' + p); ctx.annCovered('nginx.org/grpc-services');
                // gRPC needs HTTP/2. NIC v5.7.0 turns it on per host
                // (nginx.org/http2, VirtualServer spec.http2), with or without TLS.
                // Over TLS that is enough; cleartext HTTP/2 (h2c) on the default
                // listeners follows the http2 ConfigMap key, because NGINX takes
                // it from the port's default server.
                f.http2 = 'backend-protocol ' + p + ' — NGINX Ingress Controller serves gRPC only with HTTP/2 on';
                f.ann['nginx.org/http2'] = 'true'; ctx.annComment('nginx.org/http2', f.http2); ctx.annCovered('nginx.org/http2');
                if (model.hosts.some(function(h) { return h.tlsSecret === null || h.tlsSecret === undefined; })) {
                    f.cm.http2 = 'true'; f.cmComments.http2 = 'backend-protocol ' + p + ' — cleartext HTTP/2 on the default listeners follows this key';
                    ctx.note(x.annotation, 'A host without TLS gets gRPC over cleartext HTTP/2 (h2c), which on NGINX Ingress Controller\'s default listeners follows the http2 ConfigMap key rather than the per-host setting; it turns HTTP/2 on for every plaintext server.');
                }
            }
            if (backendProtocolNote(p)) ctx.note(x.annotation, backendProtocolNote(p));
            if (!services.length) ctx.todo('ann.nginx.org/ssl-services', 'name the backend Services');
        }

        // Value for a VirtualServer upstream field, from a transformed annotation value.
        function vsFieldValue(field, value, x, ctx) {
            if (field === 'buffers') {
                let parts = String(value).split(/\s+/);
                return { number: parseInt(parts[0], 10), size: parts[1] };
            }
            if (field === 'buffering' || field === 'use-cluster-ip') {
                let b = /^(1|t|true)$/i.test(value) ? true : /^(0|f|false)$/i.test(value) ? false : null;
                if (b === null) { ctx.note(x.annotation, 'Not a boolean, so not migrated.', 'warning'); return undefined; }
                return b;
            }
            if (field === 'keepalive') return parseInt(value, 10);
            return String(value);
        }

        // Name a generated resource after the Ingress, with a label per host when
        // the Ingress has several.
        function resourceName(model, host, options, used) {
            let stem = (model.name || 'my-app') + (options.nameSuffix || '');
            let label = host ? host.replace(/^\*\./, 'wildcard.').split('.')[0] : '';
            let base = model.hosts.length <= 1 || label === model.name ? stem : stem + '-' + label;
            let name = dnsName(base);
            for (let n = 2; used[name]; n++) name = dnsName(base + '-' + n);
            used[name] = true;
            return name;
        }

        function policyDoc(p, model) {
            let md = { name: p.name };
            if (model.namespace) md.namespace = model.namespace;
            return { apiVersion: NIC_API, kind: 'Policy', metadata: md, spec: p.spec };
        }

        // CRD-first: one VirtualServer per host, carrying every route, backend,
        // TLS, Policy reference and snippet; Policies and other resources beside it.
        function buildCrd(model, f, ctx, options) {
            let docs = [];
            let comments = [];
            let used = {};
            let cls = options.ingressClass || model.ingressClassName;
            let regex = !!f.regexPaths;
            // The annotation-first swap carries this in its comment; tls.redirect
            // below reads the same defaults.
            [['ssl-redirect', true], ['force-ssl-redirect', false]].forEach(function(p) {
                let v = model.community[p[0]];
                if (v !== undefined && goBool(v, null) === null) ctx.note(p[0], p[0] + ' "' + v + '" is not a boolean, so the community controller used its default, ' + p[1] + '.', 'warning');
            });

            if (f.passthrough) return buildPassthrough(model, f, ctx, options);

            // Value mappings with no VirtualServer field leave an nginx.org/*
            // annotation, which nothing reads once the Ingress is replaced. Each
            // becomes the directive NIC would have rendered, as a snippet the
            // VirtualServer template does not already emit (checked against
            // v5.6.3's and v5.7.0's: duplicates fail the reload), or is reported. Never dropped.
            let ANN_TO_SNIPPET = {
                'nginx.org/proxy-max-temp-file-size': function(v) { return { where: 'location', line: 'proxy_max_temp_file_size ' + v + ';' }; },
                'nginx.org/ssl-ciphers': function(v) { return { where: 'server', line: 'ssl_ciphers "' + String(v).replace(/"/g, '') + '";' }; },
                'nginx.org/ssl-prefer-server-ciphers': function(v) { return { where: 'server', line: 'ssl_prefer_server_ciphers ' + (truthy(v) ? 'on' : 'off') + ';' }; }
            };
            // tls.redirect covers both; next-upstream* are upstream fields.
            let HANDLED = { 'nginx.org/ssl-redirect': 1, 'nginx.org/redirect-to-https': 1, 'nginx.org/http-redirect-code': 1 };
            let redirectFrom = f.ann['nginx.org/proxy-redirect-from'];
            Object.keys(f.ann).forEach(function(key) {
                if (HANDLED[key] || ctx.covered[key]) return;
                let src = (ctx.annComments[key] || key).split(' ')[0];
                if (key === 'nginx.org/proxy-redirect-from' || key === 'nginx.org/proxy-redirect-to') {
                    if (key === 'nginx.org/proxy-redirect-to') {
                        // The community template wrote proxy_redirect <from> only
                        // for default or off, and from defaults to off.
                        if (redirectFrom === undefined || redirectFrom === 'default' || redirectFrom === 'off') ctx.note('proxy-redirect-to', 'proxy-redirect-to applies only with a proxy-redirect-from other than default or off, so the community controller ignored it.');
                        return;
                    }
                    let to = f.ann['nginx.org/proxy-redirect-to'];
                    let line = 'proxy_redirect ' + redirectFrom + (to !== undefined && redirectFrom !== 'default' && redirectFrom !== 'off' ? ' ' + to : '') + ';';
                    f.location.push(line); ctx.snippetSource(line, 'proxy-redirect-from / proxy-redirect-to');
                    return;
                }
                if (ANN_TO_SNIPPET[key]) {
                    let s2 = ANN_TO_SNIPPET[key](f.ann[key]);
                    (s2.where === 'server' ? f.server : f.location).push(s2.line);
                    ctx.snippetSource(s2.line, src);
                    return;
                }
                ctx.note(src, key + ' has no VirtualServer form; keep an Ingress for it (annotation-first) or set it in the nginx-config ConfigMap if a global value will do.', 'warning');
            });

            f.policies.forEach(function(p) { docs.push(policyDoc(p, model)); comments.push(prefixComments(p.comments, '')); });
            // A per-route Policy (access control with denies first) goes on
            // every route, where it renders after the route's own snippets.
            let policyRefs = f.policies.filter(function(p) { return !p.perRoute; }).map(function(p) { return { name: p.name }; });
            let routePolicies = f.policies.filter(function(p) { return p.perRoute; });

            if (!model.hosts.length) {
                ctx.note('host', 'This Ingress has no rule with a host, and a VirtualServer needs one. Add a host, or keep the Ingress (annotation-first).', 'warning');
            }

            let errorCodes = f.errorCodes && f.errorCodes.length ? f.errorCodes : null;
            // An Ingress-wide rewrite with $n needs the path to have the capture.
            let rewriteNotes = {};

            model.hosts.concat((f.aliases || []).filter(function(al) { return !model.hosts.some(function(h) { return h.host === al; }); }).map(function(al) {
                return { host: al, paths: model.hosts.length ? model.hosts[0].paths : [], tlsSecret: model.hosts.length ? model.hosts[0].tlsSecret : null, alias: true };
            })).forEach(function(h) {
                let spec = {};
                let c = {};
                if (cls) spec.ingressClassName = cls;
                spec.host = h.host;
                if (h.alias) c['spec.host'] = 'server-alias';
                if (h.tlsSecret !== null && h.tlsSecret !== undefined) {
                    spec.tls = {};
                    if (h.tlsSecret) spec.tls.secret = h.tlsSecret;
                    else ctx.note('tls', 'Host ' + h.host + ' is in spec.tls without a secretName; NGINX Ingress Controller then serves it only with a -wildcard-tls-secret.', 'note');
                    c['spec.tls'] = 'spec.tls';
                    // The community controller redirects when the request scheme is
                    // http: $scheme, or X-Forwarded-Proto under its global
                    // use-forwarded-headers (lua_ingress.lua). With TLS here,
                    // ssl-redirect (default true) and force-ssl-redirect both mean
                    // a redirect on the scheme, which is tls.redirect's default.
                    let sslRedirect = model.community['ssl-redirect'];
                    let force = goBool(model.community['force-ssl-redirect'], false);
                    if (goBool(sslRedirect, true) || force) {
                        spec.tls.redirect = { enable: true, code: 308 };
                        c['spec.tls.redirect'] = force ? 'force-ssl-redirect' : sslRedirect !== undefined ? 'ssl-redirect' : 'ssl-redirect (community default true with TLS)';
                        c['spec.tls.redirect.code'] = 'the community redirect code';
                    }
                } else if (goBool(model.community['force-ssl-redirect'], false)) {
                    // No TLS on this host: TLS ends in front of the controller.
                    // The community controller still redirected on $scheme, which
                    // is http for every request here unless its global
                    // use-forwarded-headers was on — then on X-Forwarded-Proto.
                    ctx.note('force-ssl-redirect', 'Host ' + h.host + ' has no TLS on the Ingress, so TLS ends in front of the controller. If the community ConfigMap had use-forwarded-headers: "true", redirect on the header: add tls with redirect.basedOn x-forwarded-proto (and no secret), or nginx.org/redirect-to-https on an Ingress. Otherwise the community controller redirected every request, including those that arrived over HTTPS, in a loop.', 'warning');
                }
                if (f.http2) { spec.http2 = true; c['spec.http2'] = f.http2; }
                if (policyRefs.length) { spec.policies = policyRefs.slice(); c['spec.policies'] = 'the Policies above'; }
                if (f.policies.some(function(p) { return p.needsTls; }) && !spec.tls) ctx.note('auth-tls-secret', 'Host ' + h.host + ' does not terminate TLS, so NGINX Ingress Controller answers every request with 500 for the ingressMTLS Policy. Add TLS for it.', 'warning');
                if (f.server.length) { spec['server-snippets'] = snippetBlock(f.server); c['spec.server-snippets'] = snippetSourcesFor(f.server, ctx); }

                let upstreams = [];
                let taken = {};
                let routes = [];
                // NGINX tries regex locations in the order they are written and
                // takes the first match, and NIC writes VirtualServer routes in
                // order. The community controller sorted a host's paths longest
                // first (ties: reverse lexical), so "/api(/|$)(.*)" was tried
                // before "/" — keep that order or "/" swallows everything.
                let ordered = regex ? h.paths.slice().sort(function(x, y) { return y.path.length - x.path.length || (y.path > x.path ? 1 : y.path < x.path ? -1 : 0); }) : h.paths;
                ordered.forEach(function(p, pi) {
                    if (!p.backend || p.backend.resource) { ctx.note('backend', 'Path ' + p.path + ' on ' + h.host + ' has a resource backend, which VirtualServer cannot route to; it is skipped.', 'warning'); return; }
                    let up = upstreamName(p.backend.service, p.backend.port, taken);
                    if (!upstreams.some(function(u) { return u.name === up; })) {
                        let u = { name: up, service: p.backend.service, port: upstreamPort(p.backend.port, ctx, 'spec.upstreams.' + upstreams.length + '.port') };
                        Object.keys(f.upstream).forEach(function(k) { u[k] = f.upstream[k]; });
                        upstreams.push(u);
                    }
                    let route = { path: vsRoutePath(p, regex && p.pathType !== 'Exact') };
                    let action;
                    if (f.redirect) {
                        action = { redirect: { url: f.redirect.url, code: f.redirect.code } };
                        c['spec.routes.' + routes.length + '.action.redirect'] = f.redirect.source;
                    } else {
                        let proxy = Object.assign({}, f.proxy);
                        if (f.rewrite !== null && f.rewrite !== undefined) {
                            let refs = captureRefs(f.rewrite);
                            let groups = captureCount(p.path);
                            if (refs.some(function(n) { return n > groups; })) {
                                // An uncaptured $n is empty, so every request on this
                                // path went to the literal remainder (verified on
                                // nginx 1.29: "/$2" on "^/" sends everything to "/").
                                let literal = f.rewrite.replace(/\$\d/g, '') || '/';
                                if (literal === '/' && p.path === '/') {
                                    // "/" rewritten to "/" changes nothing: say nothing.
                                } else {
                                    proxy.rewritePath = literal;
                                    ctx.note('rewrite-target', 'Path "' + p.path + '" has no capture group for $' + Math.max.apply(null, refs) + ' in "' + f.rewrite + '", so the community controller sent every request on it to "' + literal + '". The route keeps that; add the capture groups to the path if that was not the intent.', 'warning');
                                }
                            } else {
                                proxy.rewritePath = f.rewrite;
                            }
                        }
                        if (Object.keys(proxy).length) {
                            action = { proxy: Object.assign({ upstream: up }, proxy) };
                            if (proxy.rewritePath !== undefined) c['spec.routes.' + routes.length + '.action.proxy.rewritePath'] = 'rewrite-target';
                            if (proxy.requestHeaders) c['spec.routes.' + routes.length + '.action.proxy.requestHeaders'] = f.requestHeaderSources;
                            if (proxy.responseHeaders) c['spec.routes.' + routes.length + '.action.proxy.responseHeaders'] = f.responseHeaderNote || 'custom-headers';
                        } else {
                            action = { pass: up };
                        }
                    }
                    if (f.canary) {
                        let canaryUp = canaryUpstream(f, ctx, options, upstreams, p, taken);
                        // Pasted alone, a canary Ingress names no stable Service:
                        // the default leg goes to a placeholder upstream for it,
                        // never to the canary (which would read as "main").
                        if (!options.canaryStable) {
                            let stableName = 'stable';
                            if (!upstreams.some(function(u) { return u.name === stableName; })) {
                                upstreams.push({ name: stableName, service: 'stable-service', port: 80 });
                                c['spec.upstreams.' + (upstreams.length - 1) + '.service'] = 'TODO: the stable Service, from the main Ingress for this host and path';
                            }
                            action = { pass: stableName };
                        }
                        let matches = f.canary.matches.map(function(m) { return { conditions: m.conditions, action: { pass: canaryUp } }; });
                        if (matches.length) { route.matches = matches; c['spec.routes.' + routes.length + '.matches'] = f.canary.matchSources; }
                        if (f.canary.weight > 0 && f.canary.weight < 100) {
                            route.splits = [{ weight: 100 - f.canary.weight, action: action }, { weight: f.canary.weight, action: { pass: canaryUp } }];
                            c['spec.routes.' + routes.length + '.splits'] = f.canary.splitSources + (f.canary.rounded ? ' (rounded from ' + f.canary.rounded + ')' : '');
                        } else if (f.canary.weight >= 100) {
                            route.action = { pass: canaryUp };
                            c['spec.routes.' + routes.length + '.action'] = 'canary-weight 100 — all traffic to the canary';
                        }
                        if (!route.splits && !route.action) route.action = action;
                    } else {
                        route.action = action;
                    }
                    let denies = [].concat.apply([], routePolicies.map(function(p) { return p.denyFirst.map(function(d) { return 'deny ' + d + ';'; }); }));
                    let lines = denies.concat(f.location);
                    if (lines.length) {
                        route['location-snippets'] = snippetBlock(lines);
                        c['spec.routes.' + routes.length + '.location-snippets'] = [routePolicies.length ? 'denylist-source-range — checked before the route Policy\'s allow list' : null, snippetSourcesFor(f.location, ctx)].filter(Boolean).join(' + ');
                    }
                    if (routePolicies.length) { route.policies = routePolicies.map(function(p) { return { name: p.name }; }); c['spec.routes.' + routes.length + '.policies'] = 'the route Policy above: it renders after the snippet, so the denies come first'; }
                    if (errorCodes) {
                        // errorPages can return a body or redirect; it cannot proxy to the
                        // error Service the community controller used. A canned body keeps
                        // the status code and never loops (a redirect to an unrouted
                        // /error would land back on this same route).
                        // No `code`: NIC keeps the original status. The body may use
                        // only ${upstream_status}.
                        route.errorPages = [{ codes: errorCodes, return: { type: 'text/html', body: '<html><body><h1>Error ${upstream_status}</h1></body></html>' } }];
                        c['spec.routes.' + routes.length + '.errorPages'] = 'custom-http-errors';
                    }
                    // Key order: path, then the rest as NIC documents them.
                    let ordered = { path: route.path };
                    ['policies', 'location-snippets', 'matches', 'splits', 'action', 'errorPages'].forEach(function(k) { if (route[k] !== undefined) ordered[k] = route[k]; });
                    routes.push(ordered);
                });
                if (f.appRoot) {
                    // app-root answered "/" with a 302 and left every other path alone.
                    routes.unshift({ path: '=/', action: { redirect: { url: '${scheme}://${host}' + f.appRoot, code: 302 } } });
                    Object.keys(c).filter(function(k) { return /^spec\.routes\.\d+/.test(k); }).sort().reverse().forEach(function(k) {
                        let m = k.match(/^spec\.routes\.(\d+)(.*)$/); c['spec.routes.' + (+m[1] + 1) + m[2]] = c[k]; delete c[k];
                    });
                    c['spec.routes.0.action.redirect'] = 'app-root';
                }
                if (!routes.length) { ctx.note('host', 'Host ' + h.host + ' has no routable path; no VirtualServer is emitted for it.', 'warning'); return; }
                spec.upstreams = upstreams;
                spec.routes = routes;
                Object.keys(f.upstreamComments).forEach(function(k) {
                    upstreams.forEach(function(u, ui) { if (u[k.split('.')[0]] !== undefined) c['spec.upstreams.' + ui + '.' + k] = f.upstreamComments[k]; });
                });
                let md = { name: resourceName(model, h.host, options, used) };
                if (model.namespace) md.namespace = model.namespace;
                docs.push({ apiVersion: NIC_API, kind: 'VirtualServer', metadata: md, spec: spec });
                comments.push(c);
            });

            if (f.wwwRedirect) wwwRedirects(model, ctx, options, docs, comments, used);
            if (model.hostless.length) ctx.note('host', model.hostless.length + ' path(s) belong to a rule with no host; a VirtualServer needs a host, so they are not migrated.', 'warning');
            if (model.defaultBackend) ctx.note('default-backend', 'spec.defaultBackend has no VirtualServer equivalent; requests for unknown paths get 404. Keep an Ingress for it, or add a catch-all route.', 'warning');
            return { docs: docs, comments: comments, swaps: {} };
        }

        function prefixComments(map, prefix) {
            let out = {};
            Object.keys(map || {}).forEach(function(k) { out[prefix + k] = map[k]; });
            return out;
        }

        // The community annotations behind a snippet block, by the lines in it.
        function snippetSourcesFor(lines, ctx) {
            let names = [];
            lines.forEach(function(l) {
                let s = snippetComment(l, ctx);
                if (!s) return;
                let short = s.split(' (')[0];
                if (names.indexOf(short) === -1) names.push(short);
            });
            return names.join(' + ') || null;
        }
        // The canary's own upstream. A canary Ingress names only the canary
        // Service; the stable one is on the main Ingress for the same host and
        // path. When both were pasted the caller passes it as canaryStable.
        function canaryUpstream(f, ctx, options, upstreams, p, taken) {
            let stable = options.canaryStable;
            if (!f.canaryResolved) {
                f.canaryResolved = true;
                if (stable) {
                    ctx.note('canary', 'Merged into the VirtualServer of Ingress ' + (stable.name || '') + ', which serves the same host and path: its backend stays the default, this one gets the matches' + (f.canary.weight > 0 ? ' and a ' + f.canary.weight + '% split' : '') + '.');
                } else {
                    ctx.todo('spec.upstreams[stable].service', 'the stable Service and port, from the main Ingress for this host and path');
                    ctx.note('canary', 'A canary Ingress names only the canary Service. Paste the main Ingress for the same host and path too, and the tool merges them into one VirtualServer.', 'warning');
                }
            }
            let canary = upstreams.find(function(u) { return u.service === (p.backend && p.backend.service); });
            return canary ? canary.name : upstreams[0].name;
        }

        // TLS passthrough: NGINX hands the TLS stream to the Pod untouched, so
        // nothing HTTP-level applies (the community controller ignored every
        // other annotation too). One TransportServer per host.
        function buildPassthrough(model, f, ctx, options) {
            let docs = [];
            let used = {};
            model.hosts.forEach(function(h) {
                let p = h.paths.find(function(x) { return x.backend && x.backend.service; });
                if (!p) return;
                let md = { name: resourceName(model, h.host, options, used) };
                if (model.namespace) md.namespace = model.namespace;
                let spec = {};
                let cls = options.ingressClass || model.ingressClassName;
                if (cls) spec.ingressClassName = cls;
                spec.listener = { name: 'tls-passthrough', protocol: 'TLS_PASSTHROUGH' };
                spec.host = h.host;
                spec.upstreams = [{ name: dnsName(p.backend.service), service: p.backend.service, port: upstreamPort(p.backend.port, ctx, 'spec.upstreams.0.port') }];
                spec.action = { pass: dnsName(p.backend.service) };
                docs.push({ apiVersion: NIC_API, kind: 'TransportServer', metadata: md, spec: spec });
            });
            ctx.note('ssl-passthrough', 'TLS passthrough is off by default in NGINX Ingress Controller: install with controller.enableTLSPassthrough=true (Helm) or -enable-tls-passthrough. The built-in tls-passthrough listener needs no GlobalConfiguration. As with the community controller, every other annotation on this Ingress stops applying.', 'warning');
            Object.keys(model.community).forEach(function(k) { if (k !== 'ssl-passthrough') ctx.consumed[k] = true; });
            return { docs: docs, comments: docs.map(function() { return { 'spec.listener': 'ssl-passthrough' }; }), swaps: {} };
        }

        // from-to-www-redirect: a second host (www.<host> or the bare host)
        // answering every request with a redirect to the configured host.
        function wwwRedirects(model, ctx, options, docs, comments, used) {
            model.hosts.forEach(function(h) {
                let other = /^www\./.test(h.host) ? h.host.slice(4) : 'www.' + h.host;
                if (model.hosts.some(function(x) { return x.host === other; })) return;
                let md = { name: dnsName(resourceName(model, h.host, options, used) + '-www-redirect') };
                if (model.namespace) md.namespace = model.namespace;
                let spec = {};
                let cls = options.ingressClass || model.ingressClassName;
                if (cls) spec.ingressClassName = cls;
                spec.host = other;
                if (h.tlsSecret) spec.tls = { secret: h.tlsSecret };
                spec.routes = [{ path: '/', action: { redirect: { url: '${scheme}://' + h.host + '${request_uri}', code: 308 } } }];
                docs.push({ apiVersion: NIC_API, kind: 'VirtualServer', metadata: md, spec: spec });
                comments.push({ 'spec.host': 'from-to-www-redirect', 'spec.routes.0.action.redirect.code': 'the community redirect code' });
                if (h.tlsSecret) ctx.note('from-to-www-redirect', 'The certificate in ' + h.tlsSecret + ' must also cover ' + other + ', as the community controller required.');
            });
        }

        // Annotation-first: the Ingress itself, with nginx.org/* annotations,
        // snippets and Policy references, every rule and TLS entry kept.
        function buildIngress(model, f, ctx, options) {
            if (f.passthrough) {
                ctx.note('ssl-passthrough', 'TLS passthrough has no Ingress form in NGINX Ingress Controller; it becomes a TransportServer under either strategy.');
                return buildPassthrough(model, f, ctx, options);
            }
            let docs = [];
            let comments = [];
            // An access-control Policy whose denies must come first cannot be
            // an Ingress Policy (it renders at server level, and the snippet
            // holding the denies stops the location inheriting it): the whole
            // ordered list becomes the snippet instead.
            let aclSnippet = [];
            f.policies.filter(function(p) { return p.perRoute && p.onIngress; }).forEach(function(p) {
                p.denyFirst.forEach(function(d) { aclSnippet.push('deny ' + d + ';'); });
                p.spec.accessControl.allow.forEach(function(al) { aclSnippet.push('allow ' + al + ';'); });
                aclSnippet.push('deny all;');
                aclSnippet.forEach(function(l) { ctx.snippetSource(l, 'denylist-source-range + whitelist-source-range (ordered: denies first)'); });
            });
            f.policies.forEach(function(p) {
                if (p.onIngress && !p.perRoute) { docs.push(policyDoc(p, model)); comments.push(prefixComments(p.comments, '')); }
            });
            let unsupportedPolicies = f.policies.filter(function(p) { return !p.onIngress; });
            unsupportedPolicies.forEach(function(p) {
                ctx.note(Object.keys(p.spec)[0], 'A ' + Object.keys(p.spec)[0] + ' Policy cannot be referenced from an Ingress in NGINX Ingress Controller ' + MigrationTool.NIC.VERSION + '; switch the strategy to CRD-first to use it.', 'warning');
            });
            let ann = {};
            let annComments = {};
            // Keep everything that is not a community annotation.
            Object.keys(model.annotations).forEach(function(k) {
                if (k.indexOf(COMMUNITY_PREFIX) === 0 || k === 'kubernetes.io/ingress.class') return;
                ann[k] = str(model.annotations[k]);
            });
            Object.keys(f.ann).forEach(function(k) { ann[k] = f.ann[k]; annComments[k] = ctx.annComments[k] || null; });
            let refs = f.policies.filter(function(p) { return p.onIngress && !p.perRoute; }).map(function(p) { return p.name; });
            if (refs.length) { ann['nginx.org/policies'] = refs.join(','); annComments['nginx.org/policies'] = 'the Policies above'; }
            let locLines = aclSnippet.concat(f.location);
            if (locLines.length) { ann['nginx.org/location-snippets'] = snippetBlock(locLines); annComments['nginx.org/location-snippets'] = snippetSourcesFor(locLines, ctx); }
            if (f.server.length) { ann['nginx.org/server-snippets'] = snippetBlock(f.server); annComments['nginx.org/server-snippets'] = snippetSourcesFor(f.server, ctx); }
            // A rewrite with capture groups needs the path to be a regex, and NIC
            // matches Ingress paths literally unless told otherwise. The community
            // controller's regex was case-insensitive (~*).
            let regexNeeded = f.regexPaths || model.hosts.some(function(h) { return h.paths.some(function(p) { return PATH_REGEX_CHARS.test(p.path) && p.pathType === 'ImplementationSpecific'; }); });
            if (f.rewrite !== null && f.rewrite !== undefined) {
                ann['nginx.org/rewrite-target'] = f.rewrite; annComments['nginx.org/rewrite-target'] = 'rewrite-target';
            }
            if (regexNeeded && f.regexPaths) {
                ann['nginx.org/path-regex'] = 'case_insensitive';
                annComments['nginx.org/path-regex'] = f.rewrite !== null && f.rewrite !== undefined ? 'rewrite-target makes every path a case-insensitive regex' : 'use-regex';
                ctx.note('path-regex', 'nginx.org/path-regex applies to every path on this Ingress, as use-regex / rewrite-target did on the community controller.');
            }
            if (f.appRoot) { ann['nginx.org/app-root'] = f.appRoot; annComments['nginx.org/app-root'] = 'app-root'; }
            // The community controller redirects with 308, which keeps the method
            // and body; NIC defaults to 301, which clients may turn into a GET.
            // With TLS and no ssl-redirect, both controllers redirect HTTP to
            // HTTPS by default; only the code differs.
            let tlsDefault = model.tls.length && model.community['ssl-redirect'] === undefined;
            if ((ann['nginx.org/ssl-redirect'] === 'true' || ann['nginx.org/redirect-to-https'] === 'true' || tlsDefault) && !ann['nginx.org/http-redirect-code']) {
                ann['nginx.org/http-redirect-code'] = '308';
                annComments['nginx.org/http-redirect-code'] = 'the community redirect code (308 keeps the method and body; NGINX Ingress Controller defaults to 301)';
            }
            if (f.redirect) ctx.note(f.redirect.source, 'A redirect action has no Ingress annotation; switch the strategy to CRD-first, which emits a VirtualServer redirect.', 'warning');
            if (f.canary) ctx.note('canary', 'Traffic splitting has no Ingress annotation; switch the strategy to CRD-first, which emits VirtualServer splits and matches.', 'warning');
            if (f.wwwRedirect) ctx.note('from-to-www-redirect', 'A host redirect has no Ingress annotation; switch the strategy to CRD-first, which emits a redirecting VirtualServer.', 'warning');
            if (f.aliases && f.aliases.length) ctx.note('server-alias', 'Add ' + f.aliases.join(', ') + ' as further rules on the Ingress (and its TLS hosts), or switch to CRD-first, which emits a VirtualServer per alias.', 'warning');
            if (f.proxy.responseHeaders) { /* custom-headers placeholder already on nginx.org/add-header */ }
            if (f.sticky) {
                // nginx.org/sticky-cookie-services works on NGINX Open Source since 1.29.6.
                let services = [];
                model.hosts.forEach(function(h) { h.paths.forEach(function(p) { if (p.backend && p.backend.service && services.indexOf(p.backend.service) === -1) services.push(p.backend.service); }); });
                let s = f.sticky;
                let params = [s.name];
                if (s.expires) params.push('expires=' + s.expires);
                if (s.domain) params.push('domain=' + s.domain);
                params.push('httponly');
                if (s.secure) params.push('secure');
                if (s.path) params.push('path=' + s.path);
                ann['nginx.org/sticky-cookie-services'] = services.map(function(svc) { return 'serviceName=' + svc + ' ' + params.join(' '); }).join(';');
                annComments['nginx.org/sticky-cookie-services'] = 'affinity + session-cookie-*';
                if (s.samesite) ctx.note('session-cookie-samesite', 'nginx.org/sticky-cookie-services takes no samesite parameter; switch to CRD-first (sessionCookie.samesite) to keep it.', 'warning');
            }
            if (f.errorCodes && f.errorCodes.length) {
                ann['nginx.org/custom-http-errors'] = f.errorCodes.join(','); annComments['nginx.org/custom-http-errors'] = 'custom-http-errors';
            }
            // Upstream fields with no annotation form under annotation-first are
            // reported; the value-level mappings already wrote their annotations.
            let spec = JSON.parse(JSON.stringify(model.doc.spec || {}));
            // extensions/v1beta1 and networking.k8s.io/v1beta1 named a backend
            // serviceName/servicePort and the default backend `backend`; v1
            // wants service.name/service.port and defaultBackend.
            let v1Backend = function(b) {
                if (!isMap(b) || b.service || !b.serviceName) return b;
                let port = /^\d+$/.test(str(b.servicePort)) ? { number: parseInt(b.servicePort, 10) } : { name: str(b.servicePort) };
                return { service: { name: str(b.serviceName), port: port } };
            };
            if (spec.backend && !spec.defaultBackend) { spec.defaultBackend = spec.backend; delete spec.backend; }
            if (spec.defaultBackend) spec.defaultBackend = v1Backend(spec.defaultBackend);
            (Array.isArray(spec.rules) ? spec.rules : []).forEach(function(r) {
                ((isMap(r) && isMap(r.http) && Array.isArray(r.http.paths)) ? r.http.paths : []).forEach(function(p) {
                    if (!isMap(p)) return;
                    p.backend = v1Backend(p.backend);
                    // v1 requires a pathType; the beta APIs defaulted to ImplementationSpecific.
                    if (!p.pathType) p.pathType = 'ImplementationSpecific';
                });
            });
            let cls = options.ingressClass || model.ingressClassName;
            if (cls) spec.ingressClassName = cls;
            // nginx.org/custom-http-errors sends errors only to spec.defaultBackend.
            // Without custom-http-errors, default-backend meant only "fallback when
            // the Service has no ready endpoints", which spec.defaultBackend is not
            // (it serves requests that match no rule), so it is left alone.
            if (f.defaultBackendService && f.errorCodes && f.errorCodes.length) {
                if (!spec.defaultBackend) {
                    spec.defaultBackend = { service: { name: f.defaultBackendService, port: { number: 80 } } };
                    ctx.todo('spec.defaultBackend.service.port', 'the port of Service ' + f.defaultBackendService + ' (the community controller used its first port)');
                } else if (spec.defaultBackend.service && spec.defaultBackend.service.name !== f.defaultBackendService) {
                    ctx.note('default-backend', 'default-backend names Service ' + f.defaultBackendService + ' but spec.defaultBackend is already ' + spec.defaultBackend.service.name + ' — NGINX Ingress Controller sends custom-http-errors there.', 'warning');
                }
            } else if (f.defaultBackendService) {
                ctx.note('default-backend', 'Service ' + f.defaultBackendService + ' was the community fallback for a Service with no ready endpoints; NGINX Ingress Controller has no such fallback (on NGINX Plus, a VirtualServer upstreams[].backup is the closest). spec.defaultBackend is not the same thing, so it is not set.');
            }
            let md = { name: dnsName((model.name || 'my-app') + (options.nameSuffix || '')) };
            if (model.namespace) md.namespace = model.namespace;
            if (Object.keys(ann).length) md.annotations = ann;
            let apiVersion = 'networking.k8s.io/v1';
            if (model.apiVersion && model.apiVersion !== apiVersion) ctx.note('apiVersion', model.apiVersion + ' Ingresses no longer exist in Kubernetes 1.22+: the migrated Ingress is networking.k8s.io/v1, with its backends rewritten to service.name / service.port and a pathType on every path.');
            let ing = { apiVersion: apiVersion, kind: 'Ingress', metadata: md };
            // An Ingress pasted without a spec (an annotations-only snippet) keeps none.
            if (Object.keys(spec).length) ing.spec = spec;
            let c = {};
            Object.keys(annComments).forEach(function(k) { if (annComments[k]) c['metadata.annotations.' + k] = annComments[k]; });
            if (cls && cls !== model.ingressClassName) c['spec.ingressClassName'] = 'the NGINX Ingress Controller IngressClass';
            docs.push(ing);
            comments.push(c);
            return { docs: docs, comments: comments, swaps: ann };
        }
        // --- Analyzer source hooks ---
        // parseInput/buildPlan implement the core's analyzer contract: parseInput
        // turns raw YAML into findings + context, buildPlan turns them into a
        // MigrationPlan (pure data — migration-core.js owns all rendering).

        // Parse the paste into Ingress models. Each document is parsed on its
        // own, so one broken document is named without hiding the rest; a
        // kubectl List (or IngressList, or `-o json`) is expanded into its items.
        function parseInput(yamlText) {
            let warnings = detectIngressSyntaxWarnings(yamlText);
            let ingresses = [];
            let skipped = {};
            let errors = [];
            let docs = MigrationTool.yaml.parseDocuments(yamlText);
            docs.forEach(function(d) {
                if (d.error) { errors.push(d.error); return; }
                let items = isMap(d.value) && Array.isArray(d.value.items) && /List$/.test(str(d.value.kind)) ? d.value.items : [d.value];
                items.forEach(function(doc) {
                    if (!isMap(doc)) return;
                    if (doc.kind !== 'Ingress') { let k = doc.kind ? str(doc.kind) : 'untyped document'; skipped[k] = (skipped[k] || 0) + 1; return; }
                    ingresses.push(ingressModel(doc));
                });
            });
            errors.forEach(function(e) { warnings.push({ title: 'Could not parse part of the input', message: e + '. That document was skipped; fix it and analyze again.' }); });
            let findings = [];
            ingresses.forEach(function(m, i) {
                Object.keys(m.community).forEach(function(k) { findings.push({ annotation: k, value: m.community[k], ingress: i }); });
            });
            let skippedKinds = Object.keys(skipped);
            // Why nothing can be analyzed, in the reader's terms (the core shows
            // `empty` instead of its generic "no annotations" message).
            let empty = null;
            if (!ingresses.length) {
                if (errors.length && !skippedKinds.length) empty = { title: 'The YAML could not be parsed.', message: errors[0] + '.' };
                else if (skippedKinds.length) empty = { title: 'No Ingress found.', message: 'The input holds ' + skippedKinds.map(function(k) { return skipped[k] + ' ' + k; }).join(', ') + '. Paste a networking.k8s.io/v1 Ingress (or a kubectl list of them).' };
                else empty = { title: 'No Ingress found.', message: 'Paste a Kubernetes Ingress manifest.' };
            } else if (!findings.length) {
                empty = null; // an Ingress with no community annotations still migrates: buildPlan says how
            }
            return {
                findings: findings,
                ingresses: ingresses,
                context: ingresses[0] || null,
                warnings: warnings,
                foundCount: findings.length,
                skipped: skipped,
                empty: empty
            };
        }

        // Source-specific syntax warnings, appended after the core's generic checks.
        function detectIngressSyntaxWarnings(yamlText) {
            let warnings = [];
            // `[ \t]` rather than `\s`: \s crosses line breaks, and on a paste
            // with thousands of blank lines the old pattern backtracked for
            // seconds (A18).
            if (/^[ \t]*port:[ \t]*\n[ \t]*name:[ \t]*\S/m.test(yamlText)) {
                warnings.push({ title: 'Named service port detected', message: 'VirtualServer upstreams take a port number. Named ports are kept as a placeholder to fill in.' });
            }
            return warnings;
        }

        // Pair canary Ingresses with the main Ingress for the same host and path.
        function pairCanaries(models) {
            let pairs = new Map();
            models.forEach(function(m) {
                if (!goBool(m.community.canary, false)) return;
                // The community controller pairs a canary with the main Ingress of
                // the same namespace, host and path.
                let key = function(x) { return (x.namespace || '') + '/' + x.hosts.map(function(h) { return h.host + '|' + h.paths.map(function(p) { return p.path; }).join(','); }).join(';'); };
                let stable = models.find(function(o) { return o !== m && !goBool(o.community.canary, false) && key(o) === key(m); });
                if (stable) pairs.set(m, stable);
            });
            return pairs;
        }

        // Merge a canary into its stable Ingress's VirtualServer: the stable
        // backend is the route's default, the canary's backend gets the splits
        // and matches. Returns the stable model with the canary fragments.
        function mergeCanary(stableOut, canaryOut, stable, canary) {
            let vs = stableOut.docs.filter(function(d) { return d.kind === 'VirtualServer'; });
            let cvs = canaryOut.docs.filter(function(d) { return d.kind === 'VirtualServer'; });
            vs.forEach(function(v, i) {
                let c = cvs.find(function(x) { return x.spec.host === v.spec.host; });
                if (!c) return;
                c.spec.upstreams.forEach(function(u) { if (!v.spec.upstreams.some(function(x) { return x.service === u.service && x.port === u.port; })) { u.name = dnsName(u.name + '-canary'); v.spec.upstreams.push(u); } });
                v.spec.routes.forEach(function(r, ri) {
                    let cr = c.spec.routes[ri];
                    if (!cr) return;
                    let canaryUp = v.spec.upstreams.find(function(u) { return c.spec.upstreams.some(function(x) { return x.service === u.service && x.port === u.port; }); });
                    let up = canaryUp ? canaryUp.name : null;
                    let fix = function(a) { return a && a.pass ? { pass: up } : a; };
                    if (cr.matches) r.matches = cr.matches.map(function(m) { return { conditions: m.conditions, action: fix(m.action) }; });
                    if (cr.splits) { r.splits = [{ weight: cr.splits[0].weight, action: r.action }, { weight: cr.splits[1].weight, action: { pass: up } }]; delete r.action; }
                    let ordered = { path: r.path };
                    ['policies', 'location-snippets', 'matches', 'splits', 'action', 'errorPages'].forEach(function(k) { if (r[k] !== undefined) ordered[k] = r[k]; });
                    v.spec.routes[ri] = ordered;
                    let cc = canaryOut.comments[canaryOut.docs.indexOf(c)];
                    Object.keys(cc).filter(function(k) { return /\.(matches|splits)$/.test(k); }).forEach(function(k) { stableOut.comments[stableOut.docs.indexOf(v)][k] = cc[k]; });
                });
            });
            // The canary keeps its own notes; buildPlan lists every Ingress's.
        }
        // Run every Ingress of the paste through the assembler.
        //   options  { ingressClass, nameSuffix, ignorePreferAnnotation }
        // Returns [{ model, out }] with canary Ingresses folded into their stable one.
        function migrateAll(parsed, strategy, options) {
            options = options || {};
            let models = parsed.ingresses || [];
            let pairs = strategy === 'crd' ? pairCanaries(models) : new Map();
            let results = models.map(function(m) {
                let o = pairs.has(m) ? Object.assign({}, options, { canaryStable: pairs.get(m) }) : options;
                return { model: m, out: migrateIngress(m, strategy, o) };
            });
            if (strategy === 'crd') {
                pairs.forEach(function(stable, canary) {
                    let s = results.find(function(r) { return r.model === stable; });
                    let c = results.find(function(r) { return r.model === canary; });
                    mergeCanary(s.out, c.out, stable, canary);
                    c.mergedInto = s;
                    // The merged VirtualServer's card shows the canary Ingress too.
                    s.out.docs.forEach(function(d, i) {
                        if (d.kind !== 'VirtualServer') return;
                        (s.out.canaryOf = s.out.canaryOf || {})[i] = { model: canary, sources: (c.out.sources || [])[c.out.docs.findIndex(function(x) { return x.kind === 'VirtualServer' && x.spec.host === d.spec.host; })] || null };
                    });
                });
            }
            return results;
        }

        // The annotations block of a generated Ingress, or the YAML of a resource,
        // with each line's community source as a trailing comment.
        function docYaml(doc, comments) {
            return MigrationTool.yaml.stringify(doc, comments, {
                // Annotation values read as strings; quote them all.
                quote: function(path) { return /^metadata\.annotations\./.test(path); }
            }).replace(/\n$/, '');
        }

        // The community Ingress a card migrates, cut to the annotations that
        // produced the resource beside it (`only`), as a card always showed.
        // A resource no annotation produced (a VirtualServer for an Ingress
        // whose annotations all went to Policies, or that had none) came from
        // the Ingress's rules, so the card shows its spec instead.
        function communityYaml(model, only) {
            let ann = {};
            Object.keys(model.community).forEach(function(k) { if (!only || only.indexOf(k) !== -1) ann[COMMUNITY_PREFIX + k] = model.community[k]; });
            let md = { name: model.name || 'my-app' };
            if (model.namespace) md.namespace = model.namespace;
            let doc = { apiVersion: model.apiVersion || 'networking.k8s.io/v1', kind: 'Ingress', metadata: md };
            if (Object.keys(ann).length) md.annotations = ann;
            else if (model.doc && isMap(model.doc.spec)) doc.spec = model.doc.spec;
            return MigrationTool.yaml.stringify(doc, null, { quote: function(p) { return /^metadata\.annotations\./.test(p); } }).replace(/\n$/, '');
        }

        function configMapDoc(cm, httpSnippets) {
            let data = Object.assign({}, cm ? cm.data : {});
            let comments = {};
            Object.keys(cm ? cm.comments : {}).forEach(function(k) { comments['data.' + k] = cm.comments[k]; });
            if (httpSnippets && httpSnippets.length) {
                data['http-snippets'] = (data['http-snippets'] || '') + httpSnippets.join('\n') + '\n';
                comments['data.http-snippets'] = 'zones the migrated location snippets use';
            }
            return { doc: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'nginx-config' }, data: data }, comments: comments };
        }

        function buildPlan(parsed, strategy, options) {
            let results = migrateAll(parsed, strategy, options);
            let shown = results.filter(function(r) { return !r.mergedInto; });
            let warnings = [];
            if (Object.keys(parsed.skipped || {}).length) {
                warnings.push({ title: 'Non-Ingress documents skipped', message: Object.keys(parsed.skipped).map(function(k) { return parsed.skipped[k] + ' ' + k; }).join(', ') + ' — the analyzer reads Ingress resources only.' });
            }
            let totalAnnotations = parsed.foundCount;
            let infoNotes = [];
            let resources = [];   // { doc, comments, model, category }
            let cmAll = { data: {}, comments: {} };
            let http = [];
            let unsupportedCards = [];
            let unrecognized = [];
            let categories = {};
            results.forEach(function(r) {
                let label = (results.length > 1 && r.model.name ? r.model.name + ': ' : '');
                r.out.notes.forEach(function(n) {
                    let v = r.model.community[n.annotation];
                    let code = v !== undefined ? COMMUNITY_PREFIX + n.annotation + ': ' + v : n.annotation;
                    infoNotes.push({ code: label + code, message: n.message, severity: n.severity });
                });
                r.out.todos.forEach(function(t) { infoNotes.push({ code: label + 'TODO ' + t.path, message: 'Fill in: ' + t.message + '.', severity: 'warning' }); });
                if (r.out.configMap) Object.keys(r.out.configMap.data).forEach(function(k) {
                    if (cmAll.data[k] !== undefined && cmAll.data[k] !== r.out.configMap.data[k]) infoNotes.push({ code: 'ConfigMap ' + k, message: 'Ingresses disagree (' + cmAll.data[k] + ' vs ' + r.out.configMap.data[k] + '); the ConfigMap is global, so the first value is kept.', severity: 'warning' });
                    else { cmAll.data[k] = r.out.configMap.data[k]; cmAll.comments[k] = r.out.configMap.comments[k]; }
                });
                if (r.out.httpSnippets) r.out.httpSnippets.forEach(function(l) { if (http.indexOf(l) === -1) http.push(l); });
                r.out.unsupported.forEach(function(e) {
                    unsupportedCards.push({ title: e.mapping.category, code: e.found.map(function(x) { return x.annotation; }).join(', '), desc: e.mapping.nic, anchor: e.mapping.anchor || null, sidebarSection: e.mapping.section === 'plus' ? 'plus-mappings' : 'mappings' });
                });
                r.out.unrecognized.forEach(function(k) { if (!unrecognized.some(function(u) { return u.annotation === k; })) unrecognized.push({ annotation: k, value: r.model.community[k] }); });
                r.out.matched.forEach(function(e) { categories[e.mapping.category] = e; });
                if (!r.mergedInto) r.out.docs.forEach(function(d, i) { resources.push({ doc: d, comments: r.out.comments[i], model: r.model, sources: r.out.sources ? r.out.sources[i] : null, canary: r.out.canaryOf ? r.out.canaryOf[i] : null }); });
            });

            // Every Ingress needs one change whatever its annotations: the class.
            let classNote = 'Set spec.ingressClassName to the NGINX Ingress Controller class (the Helm chart default is "nginx", which collides with the community controller\'s: install with --set controller.ingressClass.name=nginx-nic to run both side by side).';
            infoNotes.unshift({ code: 'spec.ingressClassName', message: classNote, severity: 'note' });
            // Snippets: NIC rejects the resource unless the controller allows them.
            let usesSnippets = resources.some(function(r) {
                let s = r.doc.spec || {};
                let ann = (r.doc.metadata && r.doc.metadata.annotations) || {};
                return s['server-snippets'] || (s.routes || []).some(function(rt) { return rt['location-snippets']; }) || ann['nginx.org/location-snippets'] || ann['nginx.org/server-snippets'];
            });
            if (usesSnippets) infoNotes.unshift({ code: 'snippets', message: 'This output uses snippets, which NGINX Ingress Controller rejects unless NGINX Ingress Controller runs with -enable-snippets (Helm: controller.enableSnippets=true). Directives from community-only modules — more_set_headers (headers-more) and Lua — do not exist in NGINX Ingress Controller and fail the reload; rewrite them with add_header / proxy_set_header.', severity: 'warning' });

            // Steps ------------------------------------------------------------
            let steps = [];
            let crdItems = {};
            let ingressDocs = resources.filter(function(r) { return r.doc.kind === 'Ingress'; });
            if (ingressDocs.length) {
                steps.push({
                    id: 'analyzer-step-1',
                    title: 'Migrated Ingress',
                    countText: ingressDocs.length + ' Ingress' + (ingressDocs.length !== 1 ? 'es' : ''),
                    countCls: '',
                    desc: 'Replace the community annotations with these NGINX Ingress Controller ones. Every rule, TLS entry and backend is kept.',
                    blocks: ingressDocs.map(function(r) {
                        return { type: 'comparison', old: { title: 'Ingress-NGINX ', badge: 'current', yaml: communityYaml(r.model, r.sources) }, new: { title: 'NGINX Ingress Controller ', badge: 'migrated', yaml: docYaml(r.doc, r.comments), collapsible: true } };
                    })
                });
            }
            let cmDoc = (Object.keys(cmAll.data).length || http.length) ? configMapDoc(cmAll, http) : null;
            if (cmDoc) {
                let fromKeys = [];
                results.forEach(function(r) { if (r.out.configMap) Object.keys(r.out.configMap.comments).forEach(function(k) { let src = r.out.configMap.comments[k].split(' ')[0]; if (r.model.community[src] !== undefined) fromKeys.push(src); }); });
                let oldAnn = {};
                results.forEach(function(r) { fromKeys.forEach(function(k) { if (r.model.community[k] !== undefined) oldAnn[COMMUNITY_PREFIX + k] = r.model.community[k]; }); });
                steps.push({
                    id: 'analyzer-step-2',
                    title: 'ConfigMap changes',
                    countText: Object.keys(cmDoc.doc.data).length + ' entr' + (Object.keys(cmDoc.doc.data).length !== 1 ? 'ies' : 'y'),
                    countCls: 'configmap',
                    desc: 'These settings are global in NGINX Ingress Controller: merge them into the nginx-config ConfigMap. They apply to every Ingress and VirtualServer, not just this one.',
                    blocks: [{ type: 'comparison', old: { title: 'Ingress-NGINX (current)', badge: null, yaml: Object.keys(oldAnn).length ? MigrationTool.yaml.stringify({ metadata: { annotations: oldAnn } }, null, { quote: function() { return true; } }).replace(/\n$/, '') : '# (no annotation: required by the migrated resources)' }, new: { title: 'NGINX Ingress Controller (migrated)', badge: null, yaml: docYaml(cmDoc.doc, cmDoc.comments) } }]
                });
            }
            let crd = resources.filter(function(r) { return r.doc.kind !== 'Ingress'; });
            if (crd.length) {
                let blocks = [{ type: 'crd-install-note' }];
                let byKind = {};
                crd.forEach(function(r) { (byKind[r.doc.kind] = byKind[r.doc.kind] || []).push(r); });
                ['Policy', 'VirtualServer', 'TransportServer', 'GlobalConfiguration'].forEach(function(kind) {
                    let group = byKind[kind];
                    if (!group) return;
                    blocks.push({
                        type: 'crd-group', kind: kind,
                        countText: group.length + ' resource' + (group.length !== 1 ? 's' : ''),
                        items: group.map(function(r) {
                            return {
                                category: r.doc.metadata.name + (r.doc.spec && r.doc.spec.host ? ' — ' + r.doc.spec.host : ''),
                                plusRequired: false,
                                dualSuffix: null,
                                old: { title: 'Ingress-NGINX (current)', badge: null, yaml: communityYaml(r.model, r.sources) + (r.canary ? '\n---\n' + communityYaml(r.canary.model, r.canary.sources) : '') },
                                new: { title: 'NGINX Ingress Controller (migrated)', badge: null, yaml: docYaml(r.doc, r.comments), collapsible: true }
                            };
                        })
                    });
                });
                steps.push({
                    id: 'analyzer-step-3',
                    title: 'CRD resources',
                    countText: crd.length + ' resource' + (crd.length !== 1 ? 's' : ''),
                    countCls: 'crd',
                    desc: strategy === 'crd'
                        ? 'One VirtualServer per host replaces the Ingress, with every route, backend and TLS secret, and references the Policies beside it. Install the CRDs, apply these, then delete the community Ingress.'
                        : 'Policies the migrated Ingress references through nginx.org/policies. Install the CRDs and apply them with it.',
                    blocks: blocks
                });
            }

            let paths = Object.keys(categories).length;
            let pills = [];
            pills.push({ cls: 'found', text: totalAnnotations + ' annotation' + (totalAnnotations !== 1 ? 's' : '') + ' found', scrollTo: null });
            pills.push({ cls: 'paths', text: paths + ' migration path' + (paths !== 1 ? 's' : ''), scrollTo: steps.length ? steps[0].id : null });
            if (crd.length) pills.push({ cls: 'crds', text: crd.length + ' require CRDs', scrollTo: 'analyzer-step-3' });
            let flagged = infoNotes.filter(function(n) { return n.severity === 'warning'; }).length;
            if (flagged) pills.push({ cls: 'unrecognized', text: flagged + ' need attention', scrollTo: 'analyzer-info-notes' });
            if (unrecognized.length) pills.push({ cls: 'unrecognized', text: unrecognized.length + ' unrecognized', scrollTo: 'analyzer-unrecognized' });

            let liveText = pills.map(function(p) { return p.text; }).join(', ');
            let stepCount = steps.length;
            let usesCrd = crd.length > 0;
            let ingressCount = (parsed.ingresses || []).length;
            let banner = {
                strongText: totalAnnotations ? totalAnnotations + ' annotation' + (totalAnnotations !== 1 ? 's' : '') + ' analyzed'
                    : ingressCount + ' Ingress' + (ingressCount !== 1 ? 'es' : '') + ' with no community annotations',
                restText: (totalAnnotations ? ', ' + paths + ' migration path' + (paths !== 1 ? 's' : '') + ' across ' + stepCount + ' step' + (stepCount !== 1 ? 's' : '')
                    : ' — the resources below still need the NGINX Ingress Controller class') + (flagged ? ' — ' + flagged + ' need' + (flagged === 1 ? 's' : '') + ' attention before you apply.' : '.'),
                // Complexity is the migration's, not the strategy's: CRD-first
                // turns any Ingress into a VirtualServer, which is not "advanced".
                complexity: flagged > 2 || unsupportedCards.length ? 'advanced' : (flagged || cmDoc || Object.keys(categories).some(function(c) { let e = categories[c]; return e.mapping.type === 'policy' || e.mapping.type === 'virtualserver' || e.mapping.type === 'transportserver'; })) ? 'moderate' : 'simple'
            };

            let exportData = null;
            let parts = [];
            ingressDocs.forEach(function(r) { parts.push('# Migrated Ingress\n' + docYaml(r.doc, r.comments)); });
            if (cmDoc) parts.push('# Merge into the nginx-config ConfigMap (global)\n' + docYaml(cmDoc.doc, cmDoc.comments));
            crd.forEach(function(r) { parts.push('# ' + r.doc.kind + '\n' + docYaml(r.doc, r.comments)); });
            if (parts.length) exportData = { parts: parts };

            let nextItems = [
                { text: 'Review the full migration checklist', anchor: '#checklist' },
                { text: 'Browse all NGINX annotation mappings', anchor: '#mappings' }
            ];
            if (usesCrd) nextItems.push({ text: 'Install the required CRDs', anchor: '#installation' });
            nextItems.push({ text: 'Check the NGINX Ingress Controller docs', href: 'https://docs.nginx.com/nginx-ingress-controller/', external: true });

            return {
                pills: pills,
                liveText: liveText,
                banner: banner,
                warnings: warnings,
                steps: steps,
                infoNotes: infoNotes.map(function(n) { return { code: n.code, message: n.message, severity: n.severity }; }),
                unsupported: unsupportedCards.length ? {
                    title: 'Unsupported annotations',
                    countText: unsupportedCards.length + ' finding' + (unsupportedCards.length !== 1 ? 's' : ''),
                    desc: 'These annotations are recognized but have no NGINX Ingress Controller equivalent. Review each one and take the recommended action.',
                    cards: unsupportedCards
                } : null,
                unrecognized: unrecognized.length ? {
                    title: 'Unrecognized annotations',
                    desc: 'These annotations were not found in the migration database. They may be custom, deprecated, or not yet mapped.',
                    items: unrecognized.map(function(u) { return { yaml: MigrationTool.yaml.stringify({ annotations: { [COMMUNITY_PREFIX + u.annotation]: u.value } }, null, { quote: function() { return true; } }).replace(/\n$/, '') }; })
                } : null,
                export: exportData,
                nextItems: nextItems,
                // For nic-migrate: the assembled resources, untouched by formatting.
                resources: resources.map(function(r) { return { doc: r.doc, comments: r.comments, ingress: r.model.name, namespace: r.model.namespace }; }),
                configMap: cmDoc ? cmDoc.doc : null
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
                noFindings: { title: 'No Ingress-NGINX annotations found.', message: 'Make sure your YAML contains annotations with the nginx.ingress.kubernetes.io/ prefix.' },
                emptyStateLead: 'Paste your Ingress YAML above and click Analyze',
                emptyStateHint: 'Drag & drop a .yaml file, or try "Load Sample" for an example',
                pageNames: { 'getting-started': 'Getting started', analyzer: 'Config analyzer', reference: 'Reference guide' }
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
                    overview: 'getting-started', 'why-migrate': 'getting-started', features: 'getting-started', installation: 'getting-started', checklist: 'getting-started', 'phased-migration': 'getting-started', cli: 'getting-started', resources: 'getting-started',
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
                restText: ' — this tool migrates you to the NGINX Ingress Controller. '
            },
            analyzer: {
                strategies: {
                    initial: 'crd',
                    descriptions: {
                        annotation: 'Keep the Ingress with NGINX annotations, plus the Policies it references',
                        crd: 'A VirtualServer per host plus Policies; settings with no VirtualServer field go into its snippets'
                    }
                },
                samplePresets: SAMPLE_PRESETS,
                defaultPreset: 'moderate',
                parseInput: parseInput,
                buildPlan: buildPlan,
                mappings: ANNOTATION_MAPPINGS,
                // The per-Ingress assembler, for nic-migrate: one parsed Ingress
                // in, its migrated resources and notes out. The page goes
                // through buildPlan; the CLI calls this once per Ingress.
                migrate: function(doc, strategy, options) {
                    return migrateIngress(ingressModel(doc), strategy, options || {});
                },
                // Several parsed Ingresses at once, as the page analyzes a paste:
                // a canary Ingress folds into its stable one's VirtualServer.
                // Returns [{ doc, out, mergedInto }], mergedInto the index it joined.
                migrateMany: function(docs, strategy, options) {
                    let models = docs.map(ingressModel);
                    let results = migrateAll({ ingresses: models }, strategy, options || {});
                    return results.map(function(r, i) {
                        return { doc: docs[i], out: r.out, mergedInto: r.mergedInto ? results.indexOf(r.mergedInto) : null };
                    });
                }
            },
            export: {
                filename: 'nginx-ingress-migration.yaml',
                header: '# NGINX Ingress Migration Tool — Generated Output\n# https://kubernetes.nginx.org/ingress-nginx-migration.html'
            }
        };
    })();
