package offset

import (
	"encoding/json"
	"os"
)

type Store interface {
	Load() (CheckPoint, error)
	Save(CheckPoint) error
}

type fileStore struct{ path string }

func NewFileStore(path string) Store {
	return &fileStore{path: path}
}

func (fs *fileStore) Load() (CheckPoint, error) {
	if _, err := os.Stat(fs.path); os.IsNotExist(err) {
		return CheckPoint{}, os.ErrNotExist
	}

	bdata, err := os.ReadFile(fs.path)
	if err != nil {
		return CheckPoint{}, err
	}

	var chk CheckPoint
	if err := json.Unmarshal(bdata, &chk); err != nil {
		return CheckPoint{}, err
	}

	if chk.Data == nil {
		chk.Data = make(map[string]any)
	}

	return chk, nil
}

func (fs *fileStore) Save(chk CheckPoint) error {
	bdata, err := json.MarshalIndent(chk, "", "	")
	if err != nil {
		return err
	}
	// Debug: print what we're saving
	println("Saving checkpoint:", string(bdata))
	return os.WriteFile(fs.path, bdata, 0644)
}
