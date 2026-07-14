//! Working out a caller's real public IP behind our ingress.
//!
//! The spark used to ask api.ipify.org for its own WAN address and report it in the
//! heartbeat body. That meant a third-party call every cycle, it failed on hosts that
//! can reach the control plane but not the open internet, and — since the spark chose
//! the value — a node could report an address that wasn't its own. The control plane
//! sees the true source address of every heartbeat, so it derives it here instead.

use axum::http::HeaderMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};

/// The caller's public IPv4, or `None`.
///
/// **IPv4 only, deliberately.** This address becomes the `Endpoint` in the WireGuard
/// configs devices import. An IPv6 endpoint is unreachable for an IPv4-only phone or
/// router, and it would fail at connect time with nothing to explain why — so an
/// IPv6-only caller yields None and the operator sets an endpoint by hand.
///
/// Header precedence is a trust decision, not a preference:
///
/// * `CF-Connecting-IP` — Cloudflare *overwrites* this, so a client cannot forge it.
///   Our default ingress is a Cloudflare Tunnel, so this is the authoritative source.
/// * `X-Forwarded-For` — only the LAST entry. Proxies append, and a client may
///   prepend whatever it likes; the last hop is the only one our proxy vouched for.
///   Reading the first entry (the common mistake) would let any spark claim any IP.
/// * `X-Real-IP`, then the socket peer — for a direct or non-Cloudflare deployment.
pub fn client_ipv4(headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<String> {
    // Whichever proxy header is present is authoritative — including when it names an
    // address we can't use. Falling through to the socket peer in that case would be a
    // silent disaster behind a tunnel: the peer is cloudflared's own container address
    // (172.x.x.x), so an IPv6 visitor would set the WireGuard endpoint to a private
    // Docker IP and every device config would point somewhere unreachable.
    //
    // So: a header we understand wins; a header we don't yields None ("unknown"), not
    // a guess. The socket peer is consulted only when no proxy spoke at all — a direct
    // deployment, where the peer really is the client.
    for name in ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"] {
        let Some(raw) = headers.get(name).and_then(|v| v.to_str().ok()) else {
            continue;
        };
        // X-Forwarded-For: only the LAST entry. Proxies append, and a client may
        // prepend whatever it likes, so the last hop is the only one ours vouched for.
        let candidate = raw.rsplit(',').next().unwrap_or(raw);
        return parse_ipv4(candidate);
    }

    match peer.map(|p| p.ip()) {
        Some(IpAddr::V4(v4)) => Some(v4.to_string()),
        _ => None,
    }
}

/// Parse a header value as IPv4, tolerating a `host:port` form. Anything else —
/// including any IPv6 form — is None.
fn parse_ipv4(raw: &str) -> Option<String> {
    let s = raw.trim();
    if let Ok(v4) = s.parse::<Ipv4Addr>() {
        return Some(v4.to_string());
    }
    // "1.2.3.4:5678" — but never an IPv6 literal, which is also full of colons.
    let (host, _) = s.rsplit_once(':')?;
    host.parse::<Ipv4Addr>().ok().map(|v| v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn hm(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn prefers_cf_connecting_ip() {
        let h = hm(&[
            ("cf-connecting-ip", "203.0.113.7"),
            ("x-forwarded-for", "10.9.9.9"),
        ]);
        assert_eq!(client_ipv4(&h, None).as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn xff_takes_the_last_hop_not_the_first() {
        // A spark could prepend a forged entry; only the last was added by our proxy.
        let h = hm(&[("x-forwarded-for", "1.1.1.1, 198.51.100.4")]);
        assert_eq!(client_ipv4(&h, None).as_deref(), Some("198.51.100.4"));
    }

    #[test]
    fn ipv6_yields_none_rather_than_an_unreachable_endpoint() {
        let h = hm(&[("cf-connecting-ip", "2606:4700:4700::1111")]);
        assert_eq!(client_ipv4(&h, None), None);

        let peer: SocketAddr = "[2606:4700::1]:443".parse().unwrap();
        assert_eq!(client_ipv4(&HeaderMap::new(), Some(peer)), None);
    }

    #[test]
    fn an_unusable_header_does_not_fall_back_to_the_socket_peer() {
        // Behind a tunnel the peer is cloudflared's own container address. Falling
        // through to it on an IPv6 visitor would set the WireGuard endpoint to a
        // private Docker IP — every device config would then point nowhere.
        let cloudflared: SocketAddr = "172.18.0.3:8443".parse().unwrap();

        let h = hm(&[("cf-connecting-ip", "2606:4700::1111")]);
        assert_eq!(client_ipv4(&h, Some(cloudflared)), None);

        let h = hm(&[("cf-connecting-ip", "garbage")]);
        assert_eq!(client_ipv4(&h, Some(cloudflared)), None);
    }

    #[test]
    fn falls_back_to_the_socket_peer() {
        let peer: SocketAddr = "198.51.100.9:51820".parse().unwrap();
        assert_eq!(
            client_ipv4(&HeaderMap::new(), Some(peer)).as_deref(),
            Some("198.51.100.9")
        );
    }

    #[test]
    fn garbage_headers_dont_produce_an_ip() {
        let h = hm(&[("cf-connecting-ip", "not-an-ip")]);
        assert_eq!(client_ipv4(&h, None), None);
    }

    #[test]
    fn accepts_host_port_form() {
        assert_eq!(parse_ipv4("192.0.2.5:1234").as_deref(), Some("192.0.2.5"));
    }
}
