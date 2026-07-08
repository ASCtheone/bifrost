//! Unit tests for the pure-logic building blocks (no database required).

#[cfg(test)]
mod wg_tests {
    use crate::wg::{self, WgConfigParams};

    #[test]
    fn keypair_is_base64_32_bytes() {
        let kp = wg::generate_keypair();
        let priv_bytes = base64_decode(&kp.private_key);
        let pub_bytes = base64_decode(&kp.public_key);
        assert_eq!(priv_bytes.len(), 32, "private key must be 32 bytes");
        assert_eq!(pub_bytes.len(), 32, "public key must be 32 bytes");
        assert_ne!(kp.private_key, kp.public_key);
    }

    #[test]
    fn preshared_key_is_32_bytes() {
        assert_eq!(base64_decode(&wg::generate_preshared_key()).len(), 32);
    }

    #[test]
    fn assign_ip_is_deterministic_and_in_range() {
        let a = wg::assign_ip("dev-abc123", Some("192.168.8.1/24"));
        let b = wg::assign_ip("dev-abc123", Some("192.168.8.1/24"));
        assert_eq!(a, b, "same device id → same ip");
        assert!(a.starts_with("192.168.8."), "keeps the /24 base: {a}");
        let last: u32 = a.rsplit('.').next().unwrap().parse().unwrap();
        assert!((2..=251).contains(&last), "octet in [2,251]: {last}");
    }

    #[test]
    fn assign_ip_uses_default_subnet_when_absent() {
        let ip = wg::assign_ip("dev-x", None);
        assert!(ip.starts_with("192.168.8."));
    }

    #[test]
    fn build_config_matches_template() {
        let cfg = wg::build_config(&WgConfigParams {
            private_key: "PRIV",
            assigned_ip: "10.0.0.5",
            dns: &["1.1.1.1".into(), "8.8.8.8".into()],
            server_public_key: "SRVPUB",
            preshared_key: "PSK",
            endpoint: "1.2.3.4",
            port: 51820,
            allowed_ips: &["0.0.0.0/0".into()],
        });
        let expected = "[Interface]\n\
             PrivateKey = PRIV\n\
             Address = 10.0.0.5/32\n\
             DNS = 1.1.1.1, 8.8.8.8\n\
             \n\
             [Peer]\n\
             PublicKey = SRVPUB\n\
             PresharedKey = PSK\n\
             Endpoint = 1.2.3.4:51820\n\
             AllowedIPs = 0.0.0.0/0\n\
             PersistentKeepalive = 25\n";
        assert_eq!(cfg, expected);
    }

    fn base64_decode(s: &str) -> Vec<u8> {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        STANDARD.decode(s).expect("valid base64")
    }
}

#[cfg(test)]
mod util_tests {
    use crate::util;

    #[test]
    fn adoption_code_format() {
        let code = util::adoption_code();
        assert_eq!(code.len(), 11, "XXX-XXX-XXX");
        let parts: Vec<&str> = code.split('-').collect();
        assert_eq!(parts.len(), 3);
        for p in parts {
            assert_eq!(p.len(), 3);
            // No ambiguous characters (O/0/1/I excluded from the alphabet).
            assert!(p.chars().all(|c| !"O01I".contains(c)), "no ambiguous chars: {p}");
        }
    }

    #[test]
    fn ids_have_expected_prefixes() {
        assert!(util::node_id().starts_with("node-"));
        assert!(util::device_id().starts_with("dev-"));
        assert_eq!(util::node_key().len(), 64); // 32 bytes hex
    }

    #[test]
    fn provision_token_is_url_safe() {
        let t = util::provision_token();
        assert!(!t.is_empty());
        assert!(!t.contains('+') && !t.contains('/') && !t.contains('='), "url-safe, no padding: {t}");
    }
}

#[cfg(test)]
mod auth_tests {
    use crate::auth::password;

    #[test]
    fn password_hash_roundtrip() {
        let hash = password::hash_password("Str0ngPassword!").unwrap();
        assert!(password::verify_password("Str0ngPassword!", &hash));
        assert!(!password::verify_password("wrong", &hash));
        assert!(!password::verify_password("Str0ngPassword!", "not-a-hash"));
    }

    #[test]
    fn password_issues_flags_weak_passwords() {
        assert!(password::password_issues("short").len() >= 2);
        assert!(password::password_issues("alllowercase123").contains(&"an uppercase letter"));
        assert!(password::password_issues("Str0ngPassword!").is_empty());
    }

    #[test]
    fn jwt_issue_and_verify_roundtrip() {
        let keys = crate::auth::JwtKeys::new("test-secret", 24);
        let token = keys.issue("user-1", "a@b.com", vec!["admin".into()]).unwrap();
        let claims = keys.verify(&token).unwrap();
        assert_eq!(claims.sub, "user-1");
        assert_eq!(claims.email, "a@b.com");
        assert_eq!(claims.groups, vec!["admin".to_string()]);
    }

    #[test]
    fn jwt_rejects_wrong_secret() {
        let a = crate::auth::JwtKeys::new("secret-a", 24);
        let b = crate::auth::JwtKeys::new("secret-b", 24);
        let token = a.issue("u", "e", vec![]).unwrap();
        assert!(b.verify(&token).is_err(), "token signed with a must not verify under b");
    }
}
