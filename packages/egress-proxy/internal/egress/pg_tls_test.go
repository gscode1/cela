package egress

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func makeCA(t *testing.T, dir string) (*x509.Certificate, *ecdsa.PrivateKey, string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test ca"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	path := filepath.Join(dir, "ca.crt")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return cert, key, path
}

func leaf(t *testing.T, ca *x509.Certificate, caKey *ecdsa.PrivateKey, name string) *x509.Certificate {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return c
}

func TestDBTLSRules(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	ca, caKey, caFile := makeCA(t, dir)
	server := leaf(t, ca, caKey, "db.other.example")
	state := tls.ConnectionState{PeerCertificates: []*x509.Certificate{server}}

	if _, err := (DBTLS{Mode: "verify-ca"}).config("db.example"); err == nil ||
		err.Error() != "PI_DURABLE_DATABASE_TLS_CA_FILE is required when PI_DURABLE_DATABASE_TLS_MODE is verify-ca" {
		t.Errorf("verify-ca without a CA file: %v", err)
	}
	if _, err := (DBTLS{Mode: "bogus"}).config("x"); err == nil {
		t.Error("unknown mode accepted")
	}
	if _, err := (DBTLS{CAFile: caFile}).config("x"); err == nil {
		t.Error("a CA file without a mode accepted")
	}
	if c, err := (DBTLS{Mode: "disable"}).config("x"); err != nil || c != nil {
		t.Errorf("disable: %v %v", c, err)
	}

	// verify-ca with the CA file: the chain is verified, the name is not.
	c, err := (DBTLS{Mode: "verify-ca", CAFile: caFile}).config("db.example")
	if err != nil {
		t.Fatal(err)
	}
	if err := c.VerifyConnection(state); err != nil {
		t.Errorf("verify-ca rejected a certificate of the CA with another name: %v", err)
	}
	otherCA, otherKey, _ := makeCA(t, t.TempDir())
	foreign := leaf(t, otherCA, otherKey, "db.example")
	if err := c.VerifyConnection(tls.ConnectionState{PeerCertificates: []*x509.Certificate{foreign}}); err == nil {
		t.Error("verify-ca accepted a certificate of another CA")
	}

	// verify-full: the name is checked by the TLS stack against ServerName.
	f, err := (DBTLS{Mode: "verify-full", CAFile: caFile}).config("db.example")
	if err != nil {
		t.Fatal(err)
	}
	if f.InsecureSkipVerify || f.ServerName != "db.example" {
		t.Errorf("verify-full config: skip=%v name=%q", f.InsecureSkipVerify, f.ServerName)
	}
	if _, err := server.Verify(x509.VerifyOptions{Roots: f.RootCAs, DNSName: f.ServerName}); err == nil {
		t.Error("verify-full would accept a certificate for another name")
	}
	// verify-full without a CA file uses the system roots, still with the name checked.
	sys, err := (DBTLS{Mode: "verify-full"}).config("db.example")
	if err != nil || sys.InsecureSkipVerify || sys.ServerName != "db.example" {
		t.Errorf("verify-full with system roots: %v %+v", err, sys)
	}
}
