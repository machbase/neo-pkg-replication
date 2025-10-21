package offset

import (
	"encoding/json"
	"os"
	"time"
)

// type RFC3339Time time.Time

// func (t RFC3339Time) MarshalJSON() ([]byte, error) {
// 	return json.Marshal(time.Time(t).Format(time.RFC3339))
// }

// func (t *RFC3339Time) UnmarshalJSON(b []byte) error {
// 	var s string
// 	if err := json.Unmarshal(b, &s); err != nil {
// 		return err
// 	}

// 	if s == "" {
// 		*t = RFC3339Time(time.Time{})
// 		return nil
// 	}

// 	tt, err := time.Parse(time.RFC3339, s)
// 	if err != nil {
// 		return err
// 	}
// 	*t = RFC3339Time(tt)

// 	return nil
// }

type Store interface {
	Load() (CheckPoint, error)
	Save(CheckPoint) error
}

// 여러 DB CheckPoint 값을 한곳에서 관리, 필요한 것만 사용 -> 나중에 포인터로 변환?
type CheckPoint struct {
	// Cursor     RFC3339Time `json:"cursor"`
	Mode       string           `json:"mode"`
	Cursor     time.Time        `json:"cursor,omitempty"`
	MetaOffset int              `json:"meta_offset"`
	RIDs       map[string]int64 `json:"rids,omitempty"`
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

		// chk.Cursor = RFC3339Time(time.Now())
		chk.Cursor = time.Now()
		chk.MetaOffset = 0
		chk.RIDs = map[string]int64{}

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
