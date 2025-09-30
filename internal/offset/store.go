package offset

import (
	"encoding/json"
	"os"
	"time"
)

type Store interface {
	Load() (CheckPoint, error)
	Save(CheckPoint) error
}

type CheckPoint struct {
	Cursor     time.Time `json:"cursor"`
	MetaOffset int       `json:"meta_offset"`
}

type fileStore struct{ path string }

func NewFileStore(path string) Store {
	return &fileStore{path: path}
}

func (fs *fileStore) Load() (CheckPoint, error) {
	chk := CheckPoint{}
	if _, err := os.Stat(fs.path); os.IsNotExist(err) {
		f, err := os.OpenFile(fs.path, os.O_RDWR|os.O_CREATE, 0644)
		if err != nil {
			return CheckPoint{}, err
		}

		chk.Cursor = time.Now()
		chk.MetaOffset = 0

		err = fs.Save(chk)
		if err != nil {
			return CheckPoint{}, err
		}
		f.Close()
	}

	bdata, err := os.ReadFile(fs.path)
	if err != nil {
		return CheckPoint{}, err
	}

	if err := json.Unmarshal(bdata, &chk); err != nil {
		return CheckPoint{}, err
	}

	return chk, nil
}

func (fs *fileStore) Save(chk CheckPoint) error {
	bdata, err := json.Marshal(chk)
	if err != nil {
		return err
	}
	return os.WriteFile(fs.path, bdata, 0644)
}
