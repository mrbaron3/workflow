package githubapp

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestSignAppJWTUsesBoundedRS256Claims(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 29, 10, 11, 12, 0, time.UTC)
	token, err := SignAppJWT(key, 12345, now)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT segments = %d", len(parts))
	}
	var header map[string]string
	decodeJWTPart(t, parts[0], &header)
	if header["alg"] != "RS256" || header["typ"] != "JWT" {
		t.Fatalf("unexpected JWT header: %#v", header)
	}
	var claims map[string]int64
	decodeJWTPart(t, parts[1], &claims)
	if claims["iss"] != 12345 ||
		claims["iat"] != now.Add(-time.Minute).Unix() ||
		claims["exp"] != now.Add(9*time.Minute).Unix() {
		t.Fatalf("unexpected JWT claims: %#v", claims)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(
		&key.PublicKey,
		crypto.SHA256,
		digest[:],
		signature,
	); err != nil {
		t.Fatalf("JWT signature did not verify: %v", err)
	}
}

func decodeJWTPart(t *testing.T, raw string, target any) {
	t.Helper()
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(decoded, target); err != nil {
		t.Fatal(err)
	}
}
