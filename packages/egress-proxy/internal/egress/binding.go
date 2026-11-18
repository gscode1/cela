package egress

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

// BindingKeyBytes is the size of the key that seals the OneCLI tokens in egress.bindings (AES-256).
const BindingKeyBytes = 32

// bindingAAD is the additional data of every sealed binding, followed by the session id: a ciphertext copied to another
// session's row does not open (session-core egress-bindings.ts seals the same way; the vector test checks both sides).
const bindingAAD = "egress-binding:v1:"

// ParseBindingKey reads the key as the Secret holds it: base64 (standard or URL alphabet, padded or not) of 32 bytes.
// The error never quotes the text.
func ParseBindingKey(text string) ([]byte, error) {
	text = strings.TrimSpace(text)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(text); err == nil {
			if len(b) != BindingKeyBytes {
				return nil, errors.New("the binding key must be 32 bytes (base64)")
			}
			return b, nil
		}
	}
	return nil, errors.New("the binding key must be 32 bytes (base64)")
}

// BindingKeyID names a key without revealing it: 8 bytes of sha256 over a fixed prefix and the key, in hex. The table
// stores it beside each ciphertext so a binding sealed with another key is told apart from a corrupted one.
func BindingKeyID(key []byte) string {
	h := sha256.New()
	h.Write([]byte("egress-binding-key-id:"))
	h.Write(key)
	return hex.EncodeToString(h.Sum(nil)[:8])
}

func bindingGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != BindingKeyBytes {
		return nil, errors.New("the binding key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// OpenBinding decrypts one binding. ciphertext is the encrypted token followed by the 16-byte GCM tag (what Node's
// createCipheriv gives with getAuthTag appended). Any failure is the same error: nothing says which part was wrong.
func OpenBinding(key []byte, session string, nonce, ciphertext []byte) (string, error) {
	g, err := bindingGCM(key)
	if err != nil {
		return "", err
	}
	if len(nonce) != g.NonceSize() {
		return "", errors.New("binding cannot be opened")
	}
	plain, err := g.Open(nil, nonce, ciphertext, []byte(bindingAAD+strings.ToLower(session)))
	if err != nil || len(plain) == 0 {
		return "", errors.New("binding cannot be opened")
	}
	return string(plain), nil
}

// sealBinding is the writer's half, kept for tests (the orchestrator writes bindings, never the proxy).
func sealBinding(key []byte, session, token string, nonce []byte) []byte {
	g, err := bindingGCM(key)
	if err != nil {
		panic(err)
	}
	return g.Seal(nil, nonce, []byte(token), []byte(bindingAAD+strings.ToLower(session)))
}
