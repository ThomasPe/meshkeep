//! Where the AI API keys live (ADR-0003 principle 7): the OS credential store (Windows
//! Credential Manager, macOS Keychain, the kernel keyring on Linux), never `settings.json`,
//! the log or the feedback excerpt. One entry per provider, so a key is only ever handed to
//! the service it was stored for. Test mode keeps them in memory for the process so E2E runs
//! never touch the user's real store.

use meshkeep_engine::ai::AiProviderKind;
use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "de.devsym.meshkeep";

/// The entry's account name. Anthropic was the only provider at first and keeps the name its
/// key was stored under, so a key from an earlier version is still found.
fn user(provider: AiProviderKind) -> String {
    match provider {
        AiProviderKind::Anthropic => "ai-api-key".to_string(),
        other => format!("ai-api-key-{}", other.id()),
    }
}

pub enum AiKeyStore {
    Keyring,
    Memory(Mutex<HashMap<AiProviderKind, String>>),
}

impl AiKeyStore {
    pub fn new(test_mode: bool) -> AiKeyStore {
        if test_mode {
            AiKeyStore::Memory(Mutex::new(HashMap::new()))
        } else {
            AiKeyStore::Keyring
        }
    }

    pub fn get(&self, provider: AiProviderKind) -> Result<Option<String>, String> {
        match self {
            AiKeyStore::Memory(m) => Ok(m.lock().unwrap().get(&provider).cloned()),
            AiKeyStore::Keyring => match keyring::Entry::new(SERVICE, &user(provider))
                .map_err(|e| e.to_string())?
                .get_password()
            {
                Ok(k) => Ok(Some(k).filter(|k| !k.trim().is_empty())),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(e.to_string()),
            },
        }
    }

    /// `None` or an empty string removes the provider's key.
    pub fn set(&self, provider: AiProviderKind, key: Option<&str>) -> Result<(), String> {
        let key = key.map(str::trim).filter(|k| !k.is_empty());
        match self {
            AiKeyStore::Memory(m) => {
                let mut keys = m.lock().unwrap();
                match key {
                    Some(k) => keys.insert(provider, k.to_string()),
                    None => keys.remove(&provider),
                };
                Ok(())
            }
            AiKeyStore::Keyring => {
                let entry = keyring::Entry::new(SERVICE, &user(provider)).map_err(|e| e.to_string())?;
                match key {
                    Some(k) => entry.set_password(k).map_err(|e| e.to_string()),
                    None => match entry.delete_credential() {
                        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                        Err(e) => Err(e.to_string()),
                    },
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_has_its_own_key() {
        let store = AiKeyStore::new(true);
        store.set(AiProviderKind::OpenAi, Some("  sk-openai  ")).unwrap();
        assert_eq!(store.get(AiProviderKind::OpenAi).unwrap().as_deref(), Some("sk-openai"));
        assert_eq!(store.get(AiProviderKind::Anthropic).unwrap(), None);
        assert_eq!(store.get(AiProviderKind::Gemini).unwrap(), None);
        store.set(AiProviderKind::Gemini, Some("g-key")).unwrap();
        store.set(AiProviderKind::OpenAi, Some(" ")).unwrap();
        assert_eq!(store.get(AiProviderKind::OpenAi).unwrap(), None, "an empty key removes it");
        assert_eq!(store.get(AiProviderKind::Gemini).unwrap().as_deref(), Some("g-key"));
        // the account names in the credential store: distinct, and the first one unchanged
        let users: Vec<String> = AiProviderKind::ALL.into_iter().map(user).collect();
        assert_eq!(users, ["ai-api-key", "ai-api-key-openai", "ai-api-key-gemini"]);
    }
}
