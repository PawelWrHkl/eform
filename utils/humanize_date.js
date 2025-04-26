function humanizeData(dbResponse){
    
    for(let itemIdx=0; itemIdx<=dbResponse.length;itemIdx++){
        try{
        const createdDate = new Date(dbResponse[itemIdx].created_date);
        dbResponse[itemIdx].created_date = createdDate.toLocaleString('pl-PL');
        console.log(dbResponse)       
    }
        catch{
            console.log('Puste pole')
        }
    }
    return dbResponse;
}
module.exports = { humanizeData };