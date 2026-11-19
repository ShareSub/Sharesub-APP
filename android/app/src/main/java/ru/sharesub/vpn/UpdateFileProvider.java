package ru.sharesub.vpn;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;

public final class UpdateFileProvider extends ContentProvider {
    @Override public boolean onCreate() { return true; }

    @Override public String getType(Uri uri) {
        return "/update.apk".equals(uri.getPath()) ? "application/vnd.android.package-archive" : null;
    }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode) || getType(uri) == null) throw new FileNotFoundException();
        return ParcelFileDescriptor.open(UpdateManager.file(getContext()), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        if (getType(uri) == null) return null;
        File file = UpdateManager.file(getContext());
        String[] columns = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
        Object[] values = new Object[columns.length];
        for (int i = 0; i < columns.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) values[i] = "ShareSub.apk";
            if (OpenableColumns.SIZE.equals(columns[i])) values[i] = file.length();
        }
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        cursor.addRow(values);
        return cursor;
    }

    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
