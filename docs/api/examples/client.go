//go:build ignore

// Minimal Go client example: go run client.go photo.jpg
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type file struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

type problem struct {
	Code      string `json:"code"`
	Detail    string `json:"detail"`
	RequestID string `json:"request_id"`
}

func main() {
	base, key := os.Getenv("MEDIA_URL"), os.Getenv("MEDIA_KEY")
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}

	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, _ := w.CreateFormFile("file", filepath.Base(os.Args[1]))
	part.Write(data)
	w.Close()

	req, _ := http.NewRequest("POST", base+"/api/v1/files?visibility=public&confirm=true", &body)
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Idempotency-Key", fmt.Sprintf("example-%d", time.Now().UnixNano()))

	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		panic(err) // network error: retry with the same Idempotency-Key
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusCreated {
		var p problem
		_ = json.Unmarshal(raw, &p)
		fmt.Printf("upload failed: %d %s (%s) request_id=%s\n", resp.StatusCode, p.Code, p.Detail, p.RequestID)
		os.Exit(1)
	}
	var f file
	_ = json.Unmarshal(raw, &f)
	fmt.Println("stored", f.ID, "→", f.URL)
}
