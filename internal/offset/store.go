package offset

import (
	"os"
	"time"
)

type Store interface {
	Load() (time.Time, error)
	Save(time.Time) error
}

type fileStore struct{ path string }

func NewFileStore(path string) Store {
	return &fileStore{path: path}
}

func (f *fileStore) Load() (time.Time, error) {
	if _, err := os.Stat(f.path); os.IsNotExist(err) {
		f, err := os.OpenFile(f.path, os.O_RDWR|os.O_CREATE, 0645)
		if err != nil {
			return time.Time{}, err
		}
		_, err = f.WriteString(time.Now().Format(time.RFC3339))
		if err != nil {
			return time.Time{}, err
		}
		f.Close()
	}

	bdata, err := os.ReadFile(f.path)
	if err != nil {
		return time.Time{}, err
	}

	t, err := time.Parse(time.RFC3339, string(bdata))
	if err != nil {
		return time.Time{}, err
	}

	return t, nil
}

func (f *fileStore) Save(t time.Time) error {
	return os.WriteFile(f.path, []byte(t.Format(time.RFC3339)), 0644)
}
