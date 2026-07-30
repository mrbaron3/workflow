package githubapp

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"time"
)

func ParseRSAPrivateKeyPEM(contents []byte) (*rsa.PrivateKey, error) {
	block, rest := pem.Decode(contents)
	if block == nil || len(rest) != 0 {
		return nil, fmt.Errorf("GitHub App private key is not one PEM block")
	}
	if block.Type == "RSA PRIVATE KEY" {
		key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse GitHub App RSA private key: %w", err)
		}
		if err := key.Validate(); err != nil {
			return nil, fmt.Errorf("validate GitHub App RSA private key: %w", err)
		}
		return key, nil
	}
	if block.Type == "PRIVATE KEY" {
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse GitHub App PKCS8 private key: %w", err)
		}
		key, ok := parsed.(*rsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("GitHub App private key must be RSA")
		}
		if err := key.Validate(); err != nil {
			return nil, fmt.Errorf("validate GitHub App RSA private key: %w", err)
		}
		return key, nil
	}
	return nil, fmt.Errorf("GitHub App private key PEM type is unsupported")
}

func SignAppJWT(
	key *rsa.PrivateKey,
	appID int64,
	now time.Time,
) (string, error) {
	if key == nil || appID <= 0 {
		return "", fmt.Errorf("GitHub App JWT configuration is invalid")
	}
	header, err := json.Marshal(map[string]string{
		"alg": "RS256",
		"typ": "JWT",
	})
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(map[string]int64{
		"iat": now.Add(-60 * time.Second).Unix(),
		"exp": now.Add(9 * time.Minute).Unix(),
		"iss": appID,
	})
	if err != nil {
		return "", err
	}
	encode := base64.RawURLEncoding.EncodeToString
	unsigned := encode(header) + "." + encode(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(
		rand.Reader,
		key,
		crypto.SHA256,
		digest[:],
	)
	if err != nil {
		return "", fmt.Errorf("sign GitHub App JWT: %w", err)
	}
	return unsigned + "." + encode(signature), nil
}
